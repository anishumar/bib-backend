// The agent runtime, before there are any agents (T2.7).
//
// ── THIS IS NOT A STUB THAT LIES ────────────────────────────────────────────
//
// It is the honest, complete implementation of a true statement: **this product
// has no agents yet.** `canRun` answers false for every step, and the
// orchestrator's rule takes over — the step waits for a PERSON.
//
// That is the whole shape of the product's first goal. A firm writes its
// process, every step runs, the work gets done and is standardised and visible,
// and not one agent has been built. Agents arrive later, one step at a time,
// and nothing about a template or a job has to change for them to.
//
// It is deliberately NOT gated on config like the dev auth resolver, the logging
// mailer and the attested signer are (`validateServer` refuses those in
// production). Those three are stubs standing in for something real that must
// exist before launch. This one is a true description of the world: a firm
// running entirely on human steps is a supported, permanent way to use this
// product, not a development shortcut.
//
// T2.8 built the guardrails around this seam — confidence tiers, the decision
// rule and `delivery.agent_run` — and left this in place, which is the point of
// having done it in that order. The rails exist before anything runs on them, so
// the first real agent is a line in `setup/` and not a negotiation about what it
// is allowed to do while somebody is waiting for it to ship.
import type { AgentOutcome, AgentRuntime } from "../../usecase/orchestrator/ports";

export class NoAgentsBuiltYet implements AgentRuntime {
  /** False for everything, because it is true for everything. */
  canRun(): boolean {
    return false;
  }

  /** Named rather than left blank. A run this produced would be attributable to
   *  "no agent", which is the truth and is greppable; an empty string would look
   *  like a column somebody forgot to fill. */
  provenance(): { model: string; promptVersion: string } {
    return { model: "none", promptVersion: "none" };
  }

  /**
   * Never called by the orchestrator, which checks `canRun` first — but
   * implemented rather than thrown, because a port whose second method is a
   * landmine is one the next caller steps on.
   *
   * It reports failure rather than success. A silent "done" would mark work as
   * complete that nobody did, which is the single worst thing this engine could
   * do.
   */
  run(input: { readonly stepKey: string }): Promise<AgentOutcome> {
    return Promise.resolve({
      done: false,
      note:
        `no agent is built for step ${JSON.stringify(input.stepKey)}. This step is a person's ` +
        `until one exists: change nothing, or set the step's executor to "human" on the ` +
        `template to say so plainly.`,
    });
  }
}
