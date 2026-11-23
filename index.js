/**
 * dsh-session-delete-easy — Host half.
 *
 * Permanently removes one workspace Session: its workspace accounting, its
 * archive/pin entries, its durable session log, and its projection-checkpoint
 * record. The shipped harness can only *archive* a Session; nothing removes
 * the log.
 *
 * Why a live Session is deferred instead of purged: a Session the runtime
 * still holds (an entry in `ctx.sessions` / `ctx.agents`) keeps an open
 * write handle, and only the owner of that Agent's `AgentHandle` may tear it
 * down — a third-party plugin holds no such capability. Deleting the log
 * underneath a live handle would let the next append recreate a header-less
 * artifact. So a live Session is archived (hidden from every grouping
 * surface, its running work stopped) and marked with a sidecar file inside
 * its own artifact directory; the next Host start, when the Session is no
 * longer live, finishes the deletion.
 *
 * Nothing here imports a harness package: the plugin is plain ESM over
 * `node:*` builtins, so it loads in any profile that mounts the workspace,
 * session-persistence, and tool registries.
 */
import { readdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/** Plugin label; the patch row id is what the Loader addresses. */
export const name = 'dsh-session-delete-easy'
/** Registries and storage this plugin cannot work without. */
export const inject = ['tools', 'sessionPersistence', 'workspaceRegistry']

/** Exact Fetch route the Client half calls; `connection.fetch` paths live below `/api`. */
const ROUTE_PATH = '/api/session-delete-easy'
/**
 * Sidecar written inside a live Session's artifact directory to schedule its purge.
 * Deliberately independent of the package name: a rename must never orphan a
 * Session that an earlier build already marked for deletion.
 */
const PENDING_MARKER = '.dsh-session-delete-pending'
/** Every sidecar name the sweep accepts, newest first. */
const PENDING_MARKERS = [PENDING_MARKER, '.dsh-session-erase-pending']
/** Default delay before the startup sweep, so profile loading settles first. */
const DEFAULT_SWEEP_DELAY_MS = 4000

/** The generic JSON card every tool in this plugin renders its value through. */
const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
}

/**
 * Register the removal service, its agent tools, the Client Fetch route, and
 * the deferred-purge sweep.
 * @param ctx - Host plugin context.
 * @param config - optional `{ sweepDelayMs?: number }` from the patch row.
 */
export function apply(ctx, config = {}) {
  const log = (level, message) => {
    try {
      const sink = ctx.logger?.[level]
      if (typeof sink === 'function') sink.call(ctx.logger, `session-delete-easy: ${message}`)
    } catch {
      // Logging is best-effort and must never fail the operation it reports.
    }
  }
  const warn = (message, error) => {
    log('warn', error === undefined ? message : `${message}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const removal = createRemoval(ctx, warn)

  ctx.effect(() => ctx.tools.register(deleteTool(removal)), 'session-delete-easy: session_delete tool')
  ctx.effect(() => ctx.tools.register(listTool(removal)), 'session-delete-easy: session_delete_list tool')

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => connectionCtx.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: request => answerRoute(request, removal, warn),
    }), 'session-delete-easy: /api route')
  })

  const delay = Number.isFinite(config?.sweepDelayMs) ? Math.max(0, config.sweepDelayMs) : DEFAULT_SWEEP_DELAY_MS
  ctx.effect(() => {
    const timer = setTimeout(() => {
      removal.sweepPending().then(
        ({ purged, skipped }) => {
          if (purged.length > 0) log('info', `purged ${purged.length} session(s) marked for deletion`)
          if (skipped.length > 0) log('info', `${skipped.length} marked session(s) are still live; their purge waits for the next start`)
        },
        (error) => { warn('startup purge sweep failed', error) },
      )
    }, delay)
    return () => { clearTimeout(timer) }
  }, 'session-delete-easy: deferred purge sweep')
}

/**
 * Build the removal operations over the live registries.
 * @param ctx - Host plugin context.
 * @param warn - best-effort warning sink.
 * @returns the service the tools, the route, and the sweep share.
 */
function createRemoval(ctx, warn) {
  /**
   * Every session the runtime can see, live-preferred, with its workspace
   * accounting. `sessionQuery.listSessions()` is the authoritative corpus;
   * the persistence listing is the fallback for a profile without it.
   */
  const sessionRecords = async () => {
    const query = ctx.get('sessionQuery')
    if (typeof query?.listSessions === 'function') return await query.listSessions()
    const sessions = ctx.get('sessions')
    const snapshots = await ctx.sessionPersistence.list()
    return snapshots.map(snapshot => ({
      header: snapshot.header,
      live: sessions?.get(snapshot.header.id) !== undefined,
      persisted: true,
    }))
  }

  const workspaceAccounting = (workspaceId) => {
    const ownership = new Map()
    for (const workspace of ctx.workspaceRegistry.list()) {
      if (workspaceId !== undefined && String(workspace.id) !== String(workspaceId)) continue
      for (const sessionId of workspace.sessionIds) {
        ownership.set(String(sessionId), {
          workspaceId: String(workspace.id),
          workspaceTitle: workspace.title,
          workspacePath: workspace.path,
        })
      }
    }
    return ownership
  }

  const idOf = record => String(record?.header?.id ?? record?.id ?? '')

  /**
   * The session's own artifact directory, verified against the id before any
   * deletion. `location` comes from the persistence snapshot; `hint` is the
   * directory the caller already resolved (used when the log itself cannot be
   * read, so a corrupt log is still removable).
   */
  const artifactDirectory = async (sessionId, hint) => {
    let path
    try {
      const snapshot = await ctx.sessionPersistence.stat(sessionId)
      path = snapshot?.location?.path
    } catch (error) {
      warn(`could not read the stored location of session "${sessionId}"`, error)
    }
    const candidate = typeof path === 'string' && path.length > 0 ? dirname(path) : hint
    if (typeof candidate !== 'string' || candidate.length === 0) return undefined
    // The backend stores one directory per session, named `encodeSegment(id)`
    // under a per-project directory, and that encoding leaves `[A-Za-z0-9._-]`
    // literal while escaping `.` and `..`. Requiring the directory name to be
    // exactly the id therefore guarantees a recursive delete can never reach a
    // project directory, the sessions root, or any parent of either — and a
    // session id carrying a prefix (top-level) or not (a subagent child) both
    // name their own directory directly.
    if (basename(candidate) !== sessionId) {
      throw new Error(`refusing to delete "${candidate}": its name is not the session id "${sessionId}"`)
    }
    const root = resolveSessionsRoot(ctx)
    if (root !== undefined && dirname(dirname(candidate)) !== root) {
      throw new Error(`refusing to delete "${candidate}": it is not one project level below "${root}"`)
    }
    return candidate
  }

  const writeMarker = async (directory, sessionId) => {
    try {
      await writeFile(
        join(directory, PENDING_MARKER),
        `${JSON.stringify({ sessionId, at: new Date().toISOString() })}\n`,
        { flag: 'w' },
      )
      return true
    } catch (error) {
      warn(`could not mark session "${sessionId}" for deletion at the next start`, error)
      return false
    }
  }

  /** Remove the project directory when this was its last session. */
  const pruneEmptyProjectDirectory = async (sessionDirectory) => {
    const project = dirname(sessionDirectory)
    try {
      const remaining = await readdir(project)
      if (remaining.length === 0) await rmdir(project)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
        warn(`could not prune empty project directory "${project}"`, error)
      }
    }
  }

  /** Drop the persisted projection checkpoint, so no derived state outlives the log. */
  const removeProjectionCheckpoint = async (sessionId) => {
    try {
      const domain = ctx.get('storageDomain')?.get?.('session_projcache')
      if (domain === undefined || typeof domain.table !== 'function') return false
      return await domain.table('sessions').delete(sessionId)
    } catch (error) {
      warn(`could not remove the projection checkpoint of session "${sessionId}"`, error)
      return false
    }
  }

  /**
   * Remove the session from every workspace account. Every workspace is asked,
   * not only those whose `sessionIds` projection lists the id: that projection
   * filters candidates whose stored cwd no longer resolves, so a durable
   * account can be invisible there. `detachSession` is idempotent, and the
   * mutation also prunes filtered candidates, so asking every workspace both
   * removes the account and cleans the record.
   */
  const detachFromWorkspaces = async (sessionId) => {
    const detached = []
    for (const workspace of ctx.workspaceRegistry.list()) {
      const accounted = workspace.sessionIds.includes(sessionId)
      await workspace.detachSession(sessionId)
      detached.push({ workspaceId: String(workspace.id), listed: accounted })
    }
    return detached
  }

  /** Remove every trace of a session that no live registry entry holds. */
  const purge = async (sessionId, hint) => {
    // 1. Ask every provider to stop this session's work, so nothing writes
    //    while its artifact disappears. Silent runtime absence is success.
    try {
      await ctx.parallel('workspace/session-stop', { sessionId })
    } catch (error) {
      warn(`stopping session "${sessionId}" before deletion failed`, error)
    }

    // 2. Drop the workspace account and the archive/pin sets. The archive entry
    //    is what a deferred deletion left behind; removing it cannot introduce
    //    an unknown id.
    const detachedWorkspaceIds = await detachFromWorkspaces(sessionId)
    try {
      await ctx.workspaceRegistry.unarchiveSession(sessionId)
    } catch (error) {
      warn(`unarchiving session "${sessionId}" during deletion failed`, error)
    }
    try {
      await ctx.workspaceRegistry.unpinSession(sessionId)
    } catch (error) {
      warn(`unpinning session "${sessionId}" during deletion failed`, error)
    }

    // 3. The durable log, then its now-empty project directory.
    const artifactDir = await artifactDirectory(sessionId, hint)
    let artifactRemoved = false
    if (artifactDir !== undefined) {
      await rm(artifactDir, { recursive: true, force: true })
      artifactRemoved = true
      await pruneEmptyProjectDirectory(artifactDir)
    }

    // 4. Derived state: the FTS index reconciles deleted sources on its next
    //    search; the projection checkpoint has no eviction surface of its own.
    const projectionCheckpointRemoved = await removeProjectionCheckpoint(sessionId)

    // 5. Tell every connected browser the session is gone. The API session
    //    controller emits this on `session/disposed`, which a purged session
    //    never reaches, so a Session list would otherwise keep a dead row
    //    until its next full refresh.
    try {
      ctx.emit('api-session/removed', sessionId)
    } catch (error) {
      warn(`announcing the removal of session "${sessionId}" failed`, error)
    }

    return {
      sessionId,
      artifactRemoved,
      artifactDir: artifactDir ?? null,
      detachedWorkspaceIds,
      projectionCheckpointRemoved,
    }
  }

  const list = async ({ workspaceId } = {}) => {
    const ownership = workspaceAccounting(workspaceId)
    const archived = new Set((ctx.workspaceRegistry.archivedSessionIds ?? []).map(String))
    const pinned = new Set((ctx.workspaceRegistry.pinnedSessionIds ?? []).map(String))
    const sessions = []
    for (const record of await sessionRecords()) {
      const sessionId = idOf(record)
      if (sessionId.length === 0) continue
      const owner = ownership.get(sessionId)
      if (workspaceId !== undefined && owner === undefined) continue
      const live = record.live === true || ctx.get('agents')?.get(sessionId) !== undefined
      sessions.push({
        sessionId,
        cwd: record.header?.cwd ?? null,
        createdAt: record.header?.createdAt ?? null,
        live,
        persisted: record.persisted === true,
        archived: archived.has(sessionId),
        pinned: pinned.has(sessionId),
        workspaceId: owner?.workspaceId ?? null,
        workspaceTitle: owner?.workspaceTitle ?? null,
        /** True when this call removes the log now; false when it defers to the next start. */
        deletableNow: !live,
      })
    }
    sessions.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
    // A Session hidden by a previous deletion but not yet purged is invisible to
    // the Session corpus, so it is reported from its artifact marker instead:
    // without this, a deferred deletion has no way to be seen or confirmed.
    const pendingDeletionIds = (await scanPending()).map(entry => entry.sessionId)
    return { sessions, pendingDeletionIds }
  }

  const remove = async ({ sessionId: rawId } = {}) => {
    const sessionId = String(rawId ?? '').trim()
    if (sessionId.length === 0) throw new Error('sessionId is required')

    const record = (await sessionRecords()).find(entry => idOf(entry) === sessionId)
    const live = record?.live === true || ctx.get('agents')?.get(sessionId) !== undefined
    if (record === undefined && !live) {
      throw new Error(`session "${sessionId}" is unknown: neither a live session nor a persisted log holds it`)
    }

    if (live) {
      // Hide it now and finish at the next start; see the module doc for why the
      // log cannot be removed while the runtime still owns the session.
      const artifactDir = await artifactDirectory(sessionId)
      if (artifactDir === undefined) {
        return {
          status: 'active',
          sessionId,
          message: 'the session is live and has no durable log yet, so there is nothing to delete',
        }
      }
      const activity = await activityOf(ctx, sessionId)
      await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
      const marked = await writeMarker(artifactDir, sessionId)
      return {
        status: marked ? 'pending-restart' : 'archived',
        sessionId,
        artifactDir,
        stoppedActivity: activity,
        message: marked
          ? 'the session is live: it is hidden now and its log is removed the next time the harness starts'
          : 'the session is live: it is hidden now, but it could not be marked for deletion; delete it again after restarting',
      }
    }

    const purged = await purge(sessionId)
    return { status: 'deleted', ...purged }
  }

  /** What still runs for a session; reported so a live deletion says what it stopped. */
  const activityOf = async (context, sessionId) => {
    try {
      return await context.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    } catch (error) {
      warn(`reading the activity of session "${sessionId}" failed`, error)
      return []
    }
  }

  /**
   * Every Session a previous run marked for deletion, read from the sidecar
   * inside its own artifact directory. The marker is authoritative evidence: it
   * carries the id that was marked, so no directory name has to be decoded and
   * a prefixed (top-level) or unprefixed (subagent child) session id behaves
   * alike.
   * @returns the marked sessions with their artifact directories.
   */
  const scanPending = async () => {
    const root = resolveSessionsRoot(ctx)
    if (root === undefined) {
      warn('no session-persistence root is available; deferred deletions stay pending')
      return []
    }
    const found = []
    let projects
    try {
      projects = await readdir(root)
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`could not read the sessions root "${root}"`, error)
      return found
    }
    for (const project of projects) {
      const projectDirectory = join(root, project)
      let entries
      try {
        entries = await readdir(projectDirectory)
      } catch {
        continue
      }
      for (const entry of entries) {
        const sessionDirectory = join(projectDirectory, entry)
        let marker
        for (const markerName of PENDING_MARKERS) {
          try {
            marker = JSON.parse(await readFile(join(sessionDirectory, markerName), 'utf8'))
            break
          } catch {
            // Absent under this name, or unreadable: try the next accepted name.
          }
        }
        if (marker === undefined) continue
        const sessionId = typeof marker?.sessionId === 'string' ? marker.sessionId : undefined
        if (sessionId === undefined || basename(sessionDirectory) !== sessionId) {
          warn(`ignoring a deletion marker at "${sessionDirectory}": it does not name its own directory`)
          continue
        }
        found.push({ sessionId, sessionDirectory })
      }
    }
    return found
  }

  /** Finish every deferred deletion whose Session this runtime no longer holds. */
  const sweepPending = async () => {
    const purged = []
    const skipped = []
    for (const { sessionId, sessionDirectory } of await scanPending()) {
      if (ctx.get('sessions')?.get(sessionId) !== undefined || ctx.get('agents')?.get(sessionId) !== undefined) {
        skipped.push(sessionId)
        continue
      }
      try {
        purged.push((await purge(sessionId, sessionDirectory)).sessionId)
      } catch (error) {
        warn(`purging session "${sessionId}" marked for deletion failed`, error)
      }
    }
    return { purged, skipped }
  }

  return { list, remove, sweepPending }
}

/**
 * Resolve the persistence root for the startup sweep. The JSONL backend
 * exposes its resolved config; the same `path.resolve` is applied here so an
 * absolute root compares equal to the artifact paths the backend reports.
 * Without it, the sweep is skipped rather than guessing a path.
 * @param ctx - Host plugin context.
 * @returns the absolute root directory, or undefined when it cannot be read.
 */
function resolveSessionsRoot(ctx) {
  const configured = ctx.sessionPersistence?.config?.root
  return typeof configured === 'string' && configured.length > 0 ? resolve(configured) : undefined
}

/** The model-facing list tool: what can be deleted, and where each session lives. */
function listTool(removal) {
  return {
    name: 'session_delete_list',
    description:
      'List sessions with their workspace grouping and whether each one can be deleted now. '
      + 'A live session (one the runtime still holds open) is hidden immediately and its log is removed at the next harness start instead.',
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: 'Limit the listing to one workspace id.' },
      },
      additionalProperties: false,
    },
    output: objectOutput,
    async execute(args) {
      const workspaceId = typeof args?.workspaceId === 'string' ? args.workspaceId : undefined
      const { sessions, pendingDeletionIds } = await removal.list({ workspaceId })
      return { sessions, count: sessions.length, pendingDeletionIds }
    },
    presentCall: () => ({ card: 'generic', title: 'List sessions', kind: 'read' }),
  }
}

/** The model-facing deletion tool: permanent removal of one session. */
function deleteTool(removal) {
  return {
    name: 'session_delete',
    description:
      'Permanently delete one session: its workspace accounting, its archive and pin state, its durable log, and its projection checkpoint. '
      + 'This cannot be undone. A session the runtime still holds live is archived immediately (hidden, its running work stopped) and its log is removed at the next harness start.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Exact session id to delete, as returned by session_delete_list.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: objectOutput,
    execute: args => removal.remove(args),
    presentCall: args => ({ card: 'generic', title: `Delete session ${String(args?.sessionId ?? '')}`, kind: 'delete' }),
  }
}

/**
 * Answer one Client request. The transport already admitted the caller as the
 * owner Peer; this only dispatches and reports failures as JSON, because the
 * Client half renders the message.
 */
async function answerRoute(request, removal, warn) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'request body must be JSON' }, 400)
  }
  const action = typeof body?.action === 'string' ? body.action : 'delete'
  try {
    if (action === 'list') return json({ ok: true, ...await removal.list(body) })
    if (action === 'delete') return json({ ok: true, result: await removal.remove(body) })
    return json({ ok: false, error: `unknown action "${action}"` }, 400)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warn(`request "${action}" failed`, error)
    return json({ ok: false, error: message }, 500)
  }
}
