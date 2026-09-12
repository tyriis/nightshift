import type { Kysely } from 'kysely'
import { join } from 'node:path'
import type { Config } from '#root/main/config'
import type { FileStore } from '#root/application/ports'
import type { DB } from '#root/infra/sqlite/schema'
import { SystemClock } from '#root/infra/clock'
import { RandomIdGen } from '#root/infra/ids'
import { DiskFileStore } from '#root/infra/files/disk-file-store'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'
import { SqliteAllowlistRepo } from '#root/infra/sqlite/allowlist-repo'
import { SqliteAttachmentRepo } from '#root/infra/sqlite/attachment-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteDependencyRepo } from '#root/infra/sqlite/dependency-repo'
import { SqliteIdempotencyRepo } from '#root/infra/sqlite/idempotency-repo'
import { SqliteInboxRepo } from '#root/infra/sqlite/inbox-repo'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { SqliteLinkRepo } from '#root/infra/sqlite/link-repo'
import { SqliteSearchRepo } from '#root/infra/sqlite/search-repo'
import { SqliteSessionRepo } from '#root/infra/sqlite/session-repo'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { SqliteThreadRepo } from '#root/infra/sqlite/thread-repo'
import { SqliteUnitOfWork } from '#root/infra/sqlite/uow'
import { SqliteWebhookRepo } from '#root/infra/sqlite/webhook-repo'
import { WebhookDeliveryLoop } from '#root/infra/webhooks/delivery-loop'
import { LeaseSweeper } from '#root/infra/keepalive/lease-sweeper'
import { AddBlock } from '#root/application/usecases/add-block'
import { AddMessage } from '#root/application/usecases/add-message'
import { AnswerQuestion } from '#root/application/usecases/answer-question'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { CreateTask } from '#root/application/usecases/create-task'
import { CreateThread } from '#root/application/usecases/create-thread'
import { UpdateQuestion } from '#root/application/usecases/update-question'
import { GetContext } from '#root/application/usecases/get-context'
import { GetNext } from '#root/application/usecases/get-next'
import { Heartbeat } from '#root/application/usecases/heartbeat'
import { AddLink, RemoveLink } from '#root/application/usecases/manage-links'
import { MarkInboxRead } from '#root/application/usecases/mark-inbox-read'
import { AttachLabel, CreateLabel, DetachLabel } from '#root/application/usecases/labels'
import {
  CreateActor,
  CreateToken,
  RevokeToken,
  SetActorRole,
} from '#root/application/usecases/manage-actors'
import {
  AddAllowlist,
  ListAllowlist,
  RemoveAllowlist,
} from '#root/application/usecases/manage-allowlist'
import { GetPolicy, SetPolicy } from '#root/application/usecases/manage-policy'
import {
  CreateWebhook,
  DeleteWebhook,
  RotateWebhookSecret,
} from '#root/application/usecases/manage-webhooks'
import { ReleaseClaim } from '#root/application/usecases/release-claim'
import { RemoveBlock } from '#root/application/usecases/remove-block'
import { ProvisionHumanFromOidc } from '#root/application/usecases/provision-human'
import { SplitTask } from '#root/application/usecases/split-task'
import { UpdateStatus } from '#root/application/usecases/update-status'
import { UpdateTask } from '#root/application/usecases/update-task'
import { UploadAttachment } from '#root/application/usecases/upload-attachment'

export interface AppDeps {
  config: Config
  db: Kysely<DB>
  clock: SystemClock
  ids: RandomIdGen
  uow: SqliteUnitOfWork
  // root-connection repos for auth/queries/idempotency (outside use-case txs)
  actorsRoot: SqliteActorRepo
  // D-qq: auth-path repo, NOT in the tx Repos seam — same dual-wiring rationale as actorsRoot
  sessionsRoot: SqliteSessionRepo
  // D-tt: root-connection twin for read paths outside the use-case tx (the auth
  // callback's allow-list check rides here) — same rationale as sessionsRoot
  allowlistRoot: SqliteAllowlistRepo
  idemRoot: SqliteIdempotencyRepo
  tasksRoot: SqliteTaskRepo
  depsRoot: SqliteDependencyRepo
  labelsRoot: SqliteLabelRepo
  auditRoot: SqliteAuditRepo
  threadsRoot: SqliteThreadRepo
  inboxRoot: SqliteInboxRepo
  attachmentsRoot: SqliteAttachmentRepo
  linksRoot: SqliteLinkRepo
  webhooksRoot: SqliteWebhookRepo
  // D-gg: read-only FTS5 search — root connection only, NOT in the tx Repos seam
  searchRoot: SqliteSearchRepo
  files: FileStore
  /** D-pp: ALL OIDC-initiated HTTP goes here — tests route every call through fastify inject (zero sockets). */
  fetch: typeof globalThis.fetch
  deliveryLoop: WebhookDeliveryLoop
  leaseSweeper: LeaseSweeper
  useCases: {
    createTask: CreateTask
    updateTask: UpdateTask
    updateStatus: UpdateStatus
    splitTask: SplitTask
    claimTask: ClaimTask
    releaseClaim: ReleaseClaim
    heartbeat: Heartbeat
    addBlock: AddBlock
    removeBlock: RemoveBlock
    getNext: GetNext
    getContext: GetContext
    createThread: CreateThread
    addMessage: AddMessage
    answerQuestion: AnswerQuestion
    updateQuestion: UpdateQuestion
    markInboxRead: MarkInboxRead
    uploadAttachment: UploadAttachment
    addLink: AddLink
    removeLink: RemoveLink
    createLabel: CreateLabel
    attachLabel: AttachLabel
    detachLabel: DetachLabel
    createActor: CreateActor
    createToken: CreateToken
    revokeToken: RevokeToken
    // issue #23: humans-only role switch (PATCH /admin/actors/:id)
    setActorRole: SetActorRole
    addAllowlist: AddAllowlist
    removeAllowlist: RemoveAllowlist
    listAllowlist: ListAllowlist
    // D-tt: OIDC first-login provisioning (the callback's allow-list leg)
    provisionHumanFromOidc: ProvisionHumanFromOidc
    getPolicy: GetPolicy
    setPolicy: SetPolicy
    createWebhook: CreateWebhook
    deleteWebhook: DeleteWebhook
    rotateWebhookSecret: RotateWebhookSecret
  }
}

export const makeDepsFromDb = (
  db: Kysely<DB>,
  config: Config,
  fetchFn: typeof globalThis.fetch = globalThis.fetch
): AppDeps => {
  const clock = new SystemClock()
  const ids = new RandomIdGen()
  const uow = new SqliteUnitOfWork(db)
  const files = new DiskFileStore(join(config.dataDir, 'files')) // D-s; composition root may do IO
  return {
    config,
    db,
    clock,
    ids,
    uow,
    actorsRoot: new SqliteActorRepo(db),
    sessionsRoot: new SqliteSessionRepo(db),
    allowlistRoot: new SqliteAllowlistRepo(db),
    idemRoot: new SqliteIdempotencyRepo(db),
    tasksRoot: new SqliteTaskRepo(db),
    depsRoot: new SqliteDependencyRepo(db),
    labelsRoot: new SqliteLabelRepo(db),
    auditRoot: new SqliteAuditRepo(db),
    threadsRoot: new SqliteThreadRepo(db),
    inboxRoot: new SqliteInboxRepo(db),
    attachmentsRoot: new SqliteAttachmentRepo(db),
    linksRoot: new SqliteLinkRepo(db),
    webhooksRoot: new SqliteWebhookRepo(db),
    searchRoot: new SqliteSearchRepo(db),
    files, // shared instance: uploads and content serving hit the same store
    fetch: fetchFn, // D-pp inject-seam; production lands on globalThis.fetch
    // D-bb loop: constructed here, STARTED only by the composition root (index.ts) —
    // makeTestApp never starts it (intervalMs 0 default there) so the suite stays inert.
    // Its repo instances are its own (root connections) — the loop touches no UoW
    // (stated deviation from the background-loop clause: it needs none; all its writes
    // are single statements, global safety via Kysely's driver mutex, uow.ts:44-45).
    deliveryLoop: new WebhookDeliveryLoop(new SqliteWebhookRepo(db), new SqliteAuditRepo(db), {
      intervalMs: config.webhookIntervalMs,
      timeoutMs: config.webhookTimeoutMs,
      maxBackoffMs: config.webhookMaxBackoffMs,
    }),
    // D-iii: constructed here, STARTED only by the composition root (index.ts) —
    // makeTestApp never starts it; dormant 0/0 keeps the suite inert; rides the
    // UoW (pure DB, atomic revert+audit — the no-UoW clause guards NETWORK I/O,
    // not sqlite txs).
    leaseSweeper: new LeaseSweeper(uow, {
      intervalMs: config.keepaliveIntervalMs,
      timeoutS: config.keepaliveTimeoutS,
    }),
    useCases: {
      createTask: new CreateTask(uow, clock, ids),
      updateTask: new UpdateTask(uow, clock, ids),
      updateStatus: new UpdateStatus(uow, clock),
      splitTask: new SplitTask(uow, clock, ids),
      claimTask: new ClaimTask(uow, clock, ids, {
        interval_ms: config.keepaliveIntervalMs,
        timeout_s: config.keepaliveTimeoutS,
      }),
      releaseClaim: new ReleaseClaim(uow, clock),
      heartbeat: new Heartbeat(uow, clock),
      addBlock: new AddBlock(uow, clock),
      removeBlock: new RemoveBlock(uow, clock),
      getNext: new GetNext(new SqliteTaskRepo(db)),
      getContext: new GetContext(
        new SqliteTaskRepo(db),
        new SqliteDependencyRepo(db),
        new SqliteLabelRepo(db),
        new SqliteThreadRepo(db),
        new SqliteLinkRepo(db),
        new SqliteAttachmentRepo(db)
      ),
      createThread: new CreateThread(uow, clock, ids),
      addMessage: new AddMessage(uow, clock, ids),
      answerQuestion: new AnswerQuestion(uow, clock, ids),
      updateQuestion: new UpdateQuestion(uow, clock, ids),
      markInboxRead: new MarkInboxRead(uow),
      uploadAttachment: new UploadAttachment(uow, clock, ids, files),
      addLink: new AddLink(uow, clock, ids),
      removeLink: new RemoveLink(uow, clock),
      createLabel: new CreateLabel(uow, clock, ids),
      attachLabel: new AttachLabel(uow, clock),
      detachLabel: new DetachLabel(uow, clock),
      createActor: new CreateActor(uow, clock, ids),
      setActorRole: new SetActorRole(uow, clock),
      createToken: new CreateToken(uow, clock, ids),
      revokeToken: new RevokeToken(uow, clock),
      addAllowlist: new AddAllowlist(uow, clock),
      removeAllowlist: new RemoveAllowlist(uow, clock),
      listAllowlist: new ListAllowlist(uow),
      provisionHumanFromOidc: new ProvisionHumanFromOidc(uow, clock, ids, config.adminEmails),
      getPolicy: new GetPolicy(uow),
      setPolicy: new SetPolicy(uow, clock),
      createWebhook: new CreateWebhook(uow, clock, ids),
      deleteWebhook: new DeleteWebhook(uow, clock),
      rotateWebhookSecret: new RotateWebhookSecret(uow, clock),
    },
  }
}
