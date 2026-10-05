// The return leg between the two use cases that name each other: the work
// item service's `ObligationFiling` port, satisfied by the obligation service.
//
// It was one closure written twice, in `server.ts` and `worker.ts`, while the
// port had one method. The task-to-filing link (audit 2026-10-03, CA#36) gave
// it three more, and the calendar's row has to be put into the work-item side's
// own words on the way across, so the whole port is built here, once, and both
// processes take it. A work-item service that behaved differently in the
// worker would file a filing when a person ticked a task and not when the
// worker did, which is the reason both must have it.
//
// `obligations` is a THUNK, read at CALL time: the two services cannot both be
// constructed first, and nothing calls this before a request or a sweep, by
// which point the obligation service has long been assigned.
import type { CalendarRow } from "../usecase/obligation/ports";
import type { ObligationService } from "../usecase/obligation/service";
import type { LinkableFiling, ObligationFiling } from "../usecase/workitem/ports";

function toLinkable(r: CalendarRow): LinkableFiling {
  return {
    obligationId: r.id,
    name: r.name,
    periodLabel: r.periodLabel,
    statutoryDueOn: r.statutoryDueOn,
    entityName: r.entityName,
    stateName: r.stateName,
    filedOn: r.filedOn,
    filedByWorkItemId: r.filedByWorkItemId,
    filedByTitle: r.filedByTitle,
  };
}

export function obligationFilingPort(obligations: () => ObligationService): ObligationFiling {
  return {
    reconcileFiling: (tenantId, workItemId, discharged, actor) =>
      obligations().reconcileFiling(tenantId, workItemId, discharged, actor),
    filingsForTask: async (tenantId, workItemId, entityPartyId) => {
      const { linked, open, filedHere } = await obligations().filingsForTask(
        tenantId,
        workItemId,
        entityPartyId,
      );
      return {
        linked: linked === null ? null : toLinkable(linked),
        open: open.map(toLinkable),
        filedHere: filedHere.map(toLinkable),
      };
    },
    linkTask: (tenantId, obligationId, task, actor) =>
      obligations().linkWorkItem(tenantId, obligationId, task, actor),
    unlinkTask: (tenantId, workItemId, actor) => obligations().unlinkWorkItem(tenantId, workItemId, actor),
  };
}
