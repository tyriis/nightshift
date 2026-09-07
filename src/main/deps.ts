import type { Kysely } from 'kysely'
import type { Config } from '#root/main/config'
import type { DB } from '#root/infra/sqlite/schema'
import { SystemClock } from '#root/infra/clock'
import { RandomIdGen } from '#root/infra/ids'
import { SqliteActorRepo } from '#root/infra/sqlite/actor-repo'
import { SqliteAuditRepo } from '#root/infra/sqlite/audit-repo'
import { SqliteDependencyRepo } from '#root/infra/sqlite/dependency-repo'
import { SqliteIdempotencyRepo } from '#root/infra/sqlite/idempotency-repo'
import { SqliteLabelRepo } from '#root/infra/sqlite/label-repo'
import { SqliteTaskRepo } from '#root/infra/sqlite/task-repo'
import { SqliteUnitOfWork } from '#root/infra/sqlite/uow'
import { AddBlock } from '#root/application/usecases/add-block'
import { ClaimTask } from '#root/application/usecases/claim-task'
import { CreateTask } from '#root/application/usecases/create-task'
import { GetContext } from '#root/application/usecases/get-context'
import { GetNext } from '#root/application/usecases/get-next'
import { Heartbeat } from '#root/application/usecases/heartbeat'
import { CreateActor, CreateToken, RevokeToken } from '#root/application/usecases/manage-actors'
import { GetPolicy, SetPolicy } from '#root/application/usecases/manage-policy'
import { ReleaseClaim } from '#root/application/usecases/release-claim'
import { RemoveBlock } from '#root/application/usecases/remove-block'
import { SplitTask } from '#root/application/usecases/split-task'
import { UpdateStatus } from '#root/application/usecases/update-status'
import { UpdateTask } from '#root/application/usecases/update-task'

export interface AppDeps {
  config: Config
  db: Kysely<DB>
  clock: SystemClock
  ids: RandomIdGen
  uow: SqliteUnitOfWork
  // root-connection repos for auth/queries/idempotency (outside use-case txs)
  actorsRoot: SqliteActorRepo
  idemRoot: SqliteIdempotencyRepo
  tasksRoot: SqliteTaskRepo
  depsRoot: SqliteDependencyRepo
  labelsRoot: SqliteLabelRepo
  auditRoot: SqliteAuditRepo
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
    createActor: CreateActor
    createToken: CreateToken
    revokeToken: RevokeToken
    getPolicy: GetPolicy
    setPolicy: SetPolicy
  }
}

export const makeDepsFromDb = (db: Kysely<DB>, config: Config): AppDeps => {
  const clock = new SystemClock()
  const ids = new RandomIdGen()
  const uow = new SqliteUnitOfWork(db)
  return {
    config,
    db,
    clock,
    ids,
    uow,
    actorsRoot: new SqliteActorRepo(db),
    idemRoot: new SqliteIdempotencyRepo(db),
    tasksRoot: new SqliteTaskRepo(db),
    depsRoot: new SqliteDependencyRepo(db),
    labelsRoot: new SqliteLabelRepo(db),
    auditRoot: new SqliteAuditRepo(db),
    useCases: {
      createTask: new CreateTask(uow, clock, ids),
      updateTask: new UpdateTask(uow, clock),
      updateStatus: new UpdateStatus(uow, clock),
      splitTask: new SplitTask(uow, clock, ids),
      claimTask: new ClaimTask(uow, clock),
      releaseClaim: new ReleaseClaim(uow, clock),
      heartbeat: new Heartbeat(uow, clock),
      addBlock: new AddBlock(uow, clock),
      removeBlock: new RemoveBlock(uow, clock),
      getNext: new GetNext(new SqliteTaskRepo(db)),
      getContext: new GetContext(
        new SqliteTaskRepo(db),
        new SqliteDependencyRepo(db),
        new SqliteLabelRepo(db)
      ),
      createActor: new CreateActor(uow, clock, ids),
      createToken: new CreateToken(uow, clock, ids),
      revokeToken: new RevokeToken(uow, clock),
      getPolicy: new GetPolicy(uow),
      setPolicy: new SetPolicy(uow, clock),
    },
  }
}
