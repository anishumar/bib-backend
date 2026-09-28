// Tenancy HTTP surface — transport only. Each route below declares its wire
// shape (the `z` schemas ARE the DTOs and the OpenAPI spec at once), and each
// handler parses the validated input, calls exactly one use-case method, and
// maps the result. No business rule lives here; anything you are tempted to
// branch on belongs in the service. Errors thrown by the service propagate to
// the router's onError — one place maps and logs them, so nothing is swallowed.
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../guards";
import { z, errorResponse } from "../openapi";
import type { TenancyService } from "../../usecase/tenancy/service";
import type { StaffInviteService } from "../../usecase/staffinvite/service";
import { toEnvelope } from "../httpresp";
import { scopeOf } from "../scope";

/** What the route registrar needs. The service is the one collaborator the
 *  handlers call; the principal arrives from the session guard through the
 *  request context, so this layer never learns whether identity came from a
 *  cookie, a bearer token, or an SSO round-trip. */
export interface TenancyDeps {
  readonly service: TenancyService;
  /** Adding a colleague AND writing to them — one act, and deliberately not a
   *  method on `service`, which the portal invite also calls. */
  readonly staffInvite: StaffInviteService;
}

// ── Response schemas (describe the shapes the service returns) ──────────────

const TenantSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    status: z.enum(["active", "suspended"]),
    reportingCurrency: z.string().length(3),
  })
  .openapi("Tenant");

/** Who binds the firm — the "Yours sincerely, …, Director" block on every
 *  letter it sends. Null when the firm has not named anybody. */
const FirmSignatorySchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string().nullable().openapi({
      description: "Null when nobody has named the account — show the roster entry instead.",
    }),
    title: z.string(),
  })
  .openapi("FirmSignatory");

const FirmSignatoryResponse = z
  .object({ signatory: FirmSignatorySchema.nullable() })
  .openapi("FirmSignatoryResponse");

const SetFirmSignatoryRequest = z
  .object({
    userId: z.string().uuid(),
    title: z.string().min(1).max(120),
  })
  .openapi("SetFirmSignatoryRequest");

const UserAccountSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().nullable(),
    status: z.enum(["active", "disabled"]),
  })
  .openapi("UserAccount");

const MembershipSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    audience: z.enum(["STAFF", "CLIENT_PORTAL"]),
    role: z.string(),
    commercialVisibility: z.boolean(),
    gradeId: z.string().uuid().nullable().openapi({
      description:
        "Which rung of the firm's hierarchy this person is on — a separate axis from role. " +
        "Null is ordinary: a portal contact has no grade, and neither does somebody whose " +
        "designation the firm has never ranked. The roster read returns the rung itself.",
    }),
    reportsToUserId: z.string().uuid().nullable().openapi({
      description:
        "Who this person reports to (T2.9). Read by one thing — a `reporting_line` " +
        "verification policy deciding who may check their work. Null for a partner, for " +
        "every portal contact, and for everybody at a firm that has not filled it in.",
    }),
    isActive: z.boolean(),
  })
  .openapi("Membership");

/**
 * A membership as the ORG SWITCHER needs it — the row, plus what the firm on
 * the other end of `tenantId` is actually called.
 *
 * Its own schema rather than a `tenantName` added to `MembershipSchema`, and
 * the reason is which question each read answers. Every other route returning a
 * membership has already established the firm: an administrator changing
 * somebody's role is inside one firm and reading its name back off each row is
 * noise. THIS read is the only one that crosses firms — it is the list a person
 * who works at three of them picks from — and there the name is the entire
 * point, because "partner · b35c4196" is not a choice anybody can make.
 *
 * Nullable, because a name is being LOOKED UP rather than joined: a membership
 * whose tenant row has gone is a broken state, and saying so with a null is
 * better than refusing the whole switcher over one bad row.
 */
/**
 * What `POST /tenancy/members` answers with (T7.2).
 *
 * The membership, plus whether the WELCOME LETTER actually went. Two fields
 * rather than one because they are two questions: `invitationSent` decides what
 * the admin's screen says now, and `invitationExpiresAt` is when the link in
 * that letter stops working, which only means anything if one was sent.
 *
 * `false` is not an error — the membership is written either way, and a
 * colleague can always ask the sign-in page for a fresh link. Saying so on the
 * screen is the whole point: an administrator who is not told will believe an
 * email arrived.
 */
const InviteMemberResponse = MembershipSchema.extend({
  invitationSent: z.boolean().openapi({
    description:
      "Whether a welcome letter went out. False when the relay refused it, and false by " +
      "design for a CLIENT_PORTAL membership made on this route — that one carries no " +
      "portal grant, so it opens onto nothing and there is nothing worth announcing. Use " +
      "the portal invite route for a client.",
  }),
  invitationExpiresAt: z.string().datetime().nullable().openapi({
    description:
      "When the sign-in link in that letter stops working. Null when no letter was sent. " +
      "Hours rather than the portal invite's days: a colleague whose link expires can ask " +
      "the sign-in page for another one.",
  }),
}).openapi("InviteMemberResponse");

const MyMembershipSchema = MembershipSchema.extend({
  tenantName: z.string().nullable(),
}).openapi("MyMembership");

const MembershipsResponse = z
  .object({ memberships: z.array(MyMembershipSchema) })
  .openapi("MembershipsResponse");

/** One row of the roster: the membership plus who it belongs to, so a screen
 *  can show people without a lookup per row. */
const MemberGradeSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
    rank: z.number().int(),
    isActive: z.boolean().openapi({
      description:
        "False means the firm no longer promotes through this rung. The person really is on " +
        "it, so it is shown rather than hidden — it simply is not offered to anybody new.",
    }),
  })
  .openapi("MemberGrade");

const MemberSchema = z
  .object({
    membership: MembershipSchema,
    email: z.string().email(),
    displayName: z.string().nullable().openapi({
      description: "Null when nobody has named the account — show the email instead.",
    }),
    // Resolved, not an id: a roster that returned `gradeId` would leave the
    // screen fetching a grade per row to render a column.
    grade: MemberGradeSchema.nullable().openapi({
      description: "The rung this person sits on, or null when they are not on the ladder.",
    }),
  })
  .openapi("Member");

const MembersResponse = z.object({ members: z.array(MemberSchema) }).openapi("MembersResponse");

/** A colleague as a PICKER needs them: no email, no membership id, no
 *  revoked people. See `TenancyService.listColleagues`. */
const ColleagueSchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string().nullable().openapi({
      description: "Null when nobody has named the account. Show the role instead.",
    }),
    role: z.string(),
    gradeName: z.string().nullable(),
    gradeRank: z.number().int().nullable(),
  })
  .openapi("Colleague");

const ColleaguesResponse = z
  .object({ colleagues: z.array(ColleagueSchema) })
  .openapi("ColleaguesResponse");

// ── Request schemas (DTOs) ──────────────────────────────────────────────────

// `reportingCurrency` is required, with no default here or at any layer below.
// A firm provisioned without stating what its books are in would be given one
// silently, and the reason this is a column rather than a config row is that it
// can never be corrected afterwards — every FX rate stored later is struck
// against it. The shape is checked properly in the domain; this only turns away
// the obviously-wrong before it reaches a use case.
const CreateTenantRequest = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1),
    reportingCurrency: z.string().min(1),
  })
  .openapi("CreateTenantRequest");

const RegisterUserRequest = z
  .object({
    email: z.string().email(),
    /**
     * What a colleague calls them.
     *
     * ADDED BECAUSE ITS ABSENCE WAS UNRECOVERABLE. `POST /api/v1/tenancy/members`
     * has taken a display name since firm administration existed, so everybody a
     * firm invites gets one — but the FIRST login at a firm is created through
     * this route, before anybody exists to do the inviting, and there is no
     * route anywhere that names an account afterwards. So every firm's founding
     * partner rendered as `siddharth@10xglobal.in` on the roster, on the work
     * board, in the escalation queue and on every audit row, permanently.
     *
     * Optional, and applied only when the account is NEW — `ensureUser` is
     * idempotent by email (ADR-02) and a second provisioning call must not
     * rename somebody.
     */
    displayName: z.string().min(1).optional(),
  })
  .openapi("RegisterUserRequest");

// The administration DTOs. `audience` and `role` stay free strings on the wire
// for the same reason AddMemberRequest does: the closed audience set is a domain
// rule, and the valid ROLES are this firm's own published config — neither is
// something a static schema can state, and a duplicate list here would be a
// second place to change.
const InviteMemberRequest = z
  .object({
    email: z.string().email(),
    audience: z.string().min(1),
    role: z.string().min(1),
    commercialVisibility: z.boolean().default(false),
    displayName: z.string().min(1).optional().openapi({
      description: "Applied only when this email has no account yet.",
    }),
  })
  .openapi("InviteMemberRequest");

const ChangeMemberRoleRequest = z
  .object({ role: z.string().min(1) })
  .openapi("ChangeMemberRoleRequest");

const SetMemberActiveRequest = z
  .object({
    isActive: z.boolean().openapi({
      description:
        "False revokes access — the person's next request is refused, not their next login.",
    }),
  })
  .openapi("SetMemberActiveRequest");

// `gradeId` is nullable rather than optional, and that distinction is the whole
// DTO: `null` means "take them off the ladder", which is a decision somebody
// made. An OPTIONAL field would make an omitted key mean the same thing as a
// deliberate clearing, so a screen with a bug that dropped the field would
// silently un-grade people.
const ChangeMemberGradeRequest = z
  .object({
    gradeId: z.string().uuid().nullable().openapi({
      description: "The rung to put them on, or null to take them off the ladder.",
    }),
  })
  .openapi("ChangeMemberGradeRequest");

// Nullable rather than optional, for `ChangeMemberGradeRequest`'s reason: null
// means "this person reports to nobody", which is a decision a partner's row
// legitimately records. An omitted key would mean the same thing as that
// decision, so a screen bug that dropped the field would silently flatten the
// firm's reporting line.
const SetReportsToRequest = z
  .object({
    reportsToUserId: z.string().uuid().nullable().openapi({
      description:
        "The user id of their manager, or null for nobody. Must be an active STAFF member " +
        "of this firm — the foreign key cannot say so, because user accounts are global.",
    }),
  })
  .openapi("SetReportsToRequest");

const MemberParam = z.object({ membershipId: z.string().uuid() });

// `audience` is left a free string on the wire ON PURPOSE: the closed set of
// audiences is a domain rule (AUDIENCES), validated by the service, which
// answers 400 on a bad value. Duplicating that list here would create a second
// place to change it. The DTO checks shape; the domain owns the rule.
const AddMemberRequest = z
  .object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    audience: z.string().min(1),
    role: z.string().min(1),
    commercialVisibility: z.boolean().default(false),
  })
  .openapi("AddMemberRequest");

// ── Routes ──────────────────────────────────────────────────────────────────

const createTenantRoute = createRoute({
  method: "post",
  path: "/internal/v1/tenants",
  tags: ["tenancy"],
  summary: "Create a tenant (firm)",
  description: "Platform / service-to-service surface — above tenant scope.",
  request: {
    body: { content: { "application/json": { schema: CreateTenantRequest } }, required: true },
  },
  responses: {
    201: { description: "Tenant created", content: { "application/json": { schema: TenantSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("Missing or wrong platform key"),
    409: errorResponse("Slug already taken"),
  },
});

const registerUserRoute = createRoute({
  method: "post",
  path: "/internal/v1/users",
  tags: ["tenancy"],
  summary: "Register a user (global identity)",
  description:
    "Provisioning: creating a login is not something an anonymous caller may do, so it " +
    "requires the platform key. Idempotent by email (ADR-02): an existing email links, " +
    "never duplicates.",
  request: {
    body: { content: { "application/json": { schema: RegisterUserRequest } }, required: true },
  },
  responses: {
    201: { description: "User ensured", content: { "application/json": { schema: UserAccountSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("Missing or wrong platform key"),
  },
});

const setTenantStatusRoute = createRoute({
  method: "put",
  path: "/internal/v1/tenants/{tenantId}/status",
  tags: ["tenancy"],
  summary: "Suspend a firm, or let it back in",
  description:
    "Platform surface, and deliberately not reachable from any session: a firm cannot " +
    "suspend itself and no firm may suspend another. A suspended firm's sessions lose " +
    "their tenant context on their NEXT request — `resolveSession` reads this column on " +
    "every one — so the people signed in land on the org switcher rather than continuing " +
    "until their cookies expire. Idempotent: setting the status it already has is a 200 " +
    "and records nothing.",
  request: {
    params: z.object({ tenantId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ status: z.enum(["active", "suspended"]) })
            .openapi("SetTenantStatusRequest"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Status set", content: { "application/json": { schema: TenantSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("Missing or wrong platform key"),
    403: errorResponse("That key does not carry tenant.provision"),
    404: errorResponse("No such tenant"),
  },
});

const setUserStatusRoute = createRoute({
  method: "put",
  path: "/internal/v1/users/{userId}/status",
  tags: ["tenancy"],
  summary: "Disable a login across the platform, or let it back in",
  description:
    "NOT the same as deactivating a membership, which ends somebody's access to ONE firm " +
    "and is the firm's own decision (`PATCH /api/v1/tenancy/members/{membershipId}`). " +
    "Identity is above tenant, so this says the person may not sign in anywhere — and it " +
    "takes effect on their next request, not at session expiry.",
  request: {
    params: z.object({ userId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({ status: z.enum(["active", "disabled"]) })
            .openapi("SetUserStatusRequest"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: { description: "Status set", content: { "application/json": { schema: UserAccountSchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("Missing or wrong platform key"),
    403: errorResponse("That key does not carry user.provision"),
    404: errorResponse("No such user"),
  },
});

const addMemberRoute = createRoute({
  method: "post",
  path: "/internal/v1/memberships",
  tags: ["tenancy"],
  summary: "Grant a user access to a tenant",
  description: "Platform / service-to-service surface. Audience + role + fee visibility.",
  request: {
    body: { content: { "application/json": { schema: AddMemberRequest } }, required: true },
  },
  responses: {
    201: { description: "Membership granted", content: { "application/json": { schema: MembershipSchema } } },
    400: errorResponse("Request failed validation, or unknown audience"),
    401: errorResponse("Missing or wrong platform key"),
    404: errorResponse("Tenant or user not found"),
  },
});

// ── Firm administration ─────────────────────────────────────────────────────
//
// The product surface for a firm running itself: who works here, what they may
// do, and whether they still have access. Everything above this line on
// /internal is the PLATFORM creating firms; everything here is a partner with a
// session doing it themselves.
//
// All four require `tenant:admin`. Reading the roster is admin-only for now
// because it lists colleagues' email addresses — a general "who works here"
// directory is a wider decision for whichever screen first needs one.

const listMembersRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/members",
  tags: ["tenancy"],
  summary: "The firm's roster, deactivated people included",
  responses: {
    200: { description: "Members", content: { "application/json": { schema: MembersResponse } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
  },
});

const listColleaguesRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/colleagues",
  tags: ["tenancy"],
  summary: "Active staff, by name: whom work can be handed to",
  description:
    "The picker behind 'whose desk', 'who owns this lead' and 'who is the SPOC'. Active " +
    "STAFF members only, by name, role and grade, and WITHOUT email addresses; the roster " +
    "at /tenancy/members stays tenant:admin. Readable by anybody who can read a client.",
  responses: {
    200: {
      description: "Colleagues",
      content: { "application/json": { schema: ColleaguesResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not read clients"),
  },
});

const inviteMemberRoute = createRoute({
  method: "post",
  path: "/api/v1/tenancy/members",
  tags: ["tenancy"],
  summary: "Give somebody access to this firm, by email",
  description:
    "Idempotent on identity (ADR-02): an email that already has an account links to that " +
    "person rather than creating a second one. A STAFF member is then WRITTEN TO: a welcome " +
    "letter naming the firm, carrying a single-use sign-in link that lives 72 hours. The " +
    "response says whether it went — a refused relay does not fail the add, because the " +
    "membership stands and they can ask the sign-in page for a fresh link. A CLIENT_PORTAL " +
    "membership made here gets no letter: it carries no portal grant, so it opens onto " +
    "nothing. Invite a client through the portal invite route instead.",
  request: {
    body: { content: { "application/json": { schema: InviteMemberRequest } }, required: true },
  },
  responses: {
    201: {
      description: "Access granted, and — for a STAFF member — written to",
      content: { "application/json": { schema: InviteMemberResponse } },
    },
    400: errorResponse("Request failed validation, or unknown audience"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    409: errorResponse("They already have access, or the role is not one this firm publishes"),
  },
});

const changeMemberRoleRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/members/{membershipId}/role",
  tags: ["tenancy"],
  summary: "Change what a member may do",
  request: {
    params: MemberParam,
    body: { content: { "application/json": { schema: ChangeMemberRoleRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Role changed. Idempotent — setting the role they hold records nothing.",
      content: { "application/json": { schema: MembershipSchema } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such membership at this firm"),
    409: errorResponse("The role is not one this firm publishes, or this would leave no administrator"),
  },
});

const setMemberActiveRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/members/{membershipId}/active",
  tags: ["tenancy"],
  summary: "Revoke a member's access, or give it back",
  description:
    "Takes effect on their NEXT REQUEST, not at token expiry: the session resolver re-reads " +
    "the membership every time. A firm that dismisses somebody can stop their access now.",
  request: {
    params: MemberParam,
    body: { content: { "application/json": { schema: SetMemberActiveRequest } }, required: true },
  },
  responses: {
    200: { description: "Access changed", content: { "application/json": { schema: MembershipSchema } } },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such membership at this firm"),
    409: errorResponse("This would leave the firm with no administrator"),
  },
});

const changeMemberGradeRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/members/{membershipId}/grade",
  tags: ["tenancy"],
  summary: "Put a member on a rung of the firm's hierarchy, or take them off it",
  description:
    "Seniority is a SEPARATE axis from role: the role decides what somebody may reach, the " +
    "grade decides how senior they are, and it is the grade a review threshold compares. " +
    "Unlike a role change this can strand nobody, so there is no last-administrator guard.",
  request: {
    params: MemberParam,
    body: {
      content: { "application/json": { schema: ChangeMemberGradeRequest } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Grade changed. Idempotent — setting the rung they hold records nothing.",
      content: { "application/json": { schema: MembershipSchema } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such membership, or no such grade at this firm"),
    409: errorResponse("The firm no longer promotes through that rung"),
  },
});

const setReportsToRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/members/{membershipId}/reports-to",
  tags: ["tenancy"],
  summary: "Say who a member reports to, or clear it",
  description:
    "The FOURTH axis, and it grants nothing. One thing reads it: a `reporting_line` " +
    "verification policy deciding who may check this person's work. " +
    "Two refusals no database can make are made here — a manager who is not an active " +
    "member of this firm (user accounts are global, so the foreign key would accept a " +
    "stranger), and a loop, which would leave everybody in it with no eligible checker and " +
    "would fail silently. " +
    "NOT effective-dated: nothing records when a reporting line started, so this answers " +
    "'now' and the audit trail answers 'when did it change'.",
  request: {
    params: MemberParam,
    body: { content: { "application/json": { schema: SetReportsToRequest } }, required: true },
  },
  responses: {
    200: {
      description: "Set. Idempotent — naming the manager they already have records nothing.",
      content: { "application/json": { schema: MembershipSchema } },
    },
    400: errorResponse("Not a colleague, or the reporting line would loop"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("No such membership at this firm"),
  },
});

// ── Who binds the firm ──────────────────────────────────────────────────────
//
// One signatory for the whole firm, whichever of its entities issues the
// document — "unki ek hi signature rahegi". These two routes are the only
// reason it is a row rather than a constant: a rule nobody can change is a
// hardcode with extra steps, and a successor should be an UPDATE.
//
// The split matches the firm-entity rule (G1.2), for the same reason. READING
// is `config:read` — an associate drafting a letter should be able to see whose
// signature will be on it. WRITING is `tenant:admin`, because naming who binds
// the firm is a decision at the same level as deciding what a role means.

const firmSignatoryRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/firm-signatory",
  tags: ["tenancy"],
  summary: "Who signs this firm's engagement letters",
  description:
    "Snapshotted onto each letter when it is SENT, so changing it here never restates a " +
    "letter already issued. Null means the firm has not named anybody and its letters go " +
    "out with no signature block.",
  responses: {
    200: {
      description: "The standing signatory, or null",
      content: { "application/json": { schema: FirmSignatoryResponse } },
    },
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role does not permit it"),
  },
});

const setFirmSignatoryRoute = createRoute({
  method: "put",
  path: "/api/v1/tenancy/firm-signatory",
  tags: ["tenancy"],
  summary: "Name who binds the firm",
  description:
    "The person must have an active STAFF membership here: authority to bind the firm is the " +
    "strongest thing anyone holds in this product, and `tenancy.user_account` is global, so " +
    "no foreign key can say it. Letters already sent keep the block they went out with.",
  request: {
    body: { content: { "application/json": { schema: SetFirmSignatoryRequest } }, required: true },
  },
  responses: {
    200: { description: "Named", content: { "application/json": { schema: FirmSignatorySchema } } },
    400: errorResponse("Request failed validation"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org, or the role may not administer the firm"),
    404: errorResponse("That person has no active staff membership at this firm"),
  },
});

const renameSelfRoute = createRoute({
  method: "patch",
  path: "/api/v1/tenancy/me",
  tags: ["tenancy"],
  summary: "Correct your own display name",
  description:
    "Your account is yours across every firm you belong to, so this changes your name " +
    "everywhere. It takes no id: it can reach nobody else's account.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ displayName: z.string().max(400) }).openapi("RenameSelf"),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Renamed",
      content: {
        "application/json": {
          schema: z
            .object({ userId: z.string().uuid(), displayName: z.string().nullable() })
            .openapi("SelfName"),
        },
      },
    },
    400: errorResponse("A blank name, or longer than 200 characters"),
    401: errorResponse("No authenticated session"),
    403: errorResponse("The session has not selected an org"),
  },
});

const myMembershipsRoute = createRoute({
  method: "get",
  path: "/api/v1/tenancy/me/memberships",
  tags: ["tenancy"],
  summary: "List the caller's active memberships (org switcher)",
  responses: {
    200: { description: "Active memberships", content: { "application/json": { schema: MembershipsResponse } } },
    401: errorResponse("No authenticated principal"),
  },
});

// ── Registration ──────────────────────────────────────────────────────────

/** Mount every tenancy route on the app. Inline handlers give the framework
 *  the tightest possible type link between a route's schema and its handler:
 *  `c.req.valid("json")` is typed from the route, and the returned status +
 *  body are checked against the declared responses. */
export function registerTenancyRoutes(app: OpenAPIHono<AppEnv>, deps: TenancyDeps): void {
  app.openapi(createTenantRoute, async (c) => {
    const input = c.req.valid("json");
    const tenant = await deps.service.createTenant({
      ...input,
      provisionedBy: c.get("internalClient")?.name,
    });
    // Mapped field by field rather than returned whole. Forwarding the domain
    // object is how /auth/me shipped two fields the spec never described for six
    // tasks, and a frontend generated from that spec cannot see them.
    return c.json(
      {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        reportingCurrency: tenant.reportingCurrency,
      },
      201,
    );
  });

  app.openapi(registerUserRoute, async (c) => {
    const input = c.req.valid("json");
    const user = await deps.service.ensureUser(input.email, input.displayName);
    return c.json(user, 201);
  });

  app.openapi(setTenantStatusRoute, async (c) => {
    const { tenantId } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const tenant = await deps.service.setTenantStatus(tenantId, status, {
      // The provisioning caller, named. A suspension with "system" as its only
      // actor is a fact nobody can trace back to a decision.
      type: "system",
      id: c.get("internalClient")?.name ?? "internal",
    });
    // Field by field, like createTenant above and for the same reason.
    return c.json(
      {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        reportingCurrency: tenant.reportingCurrency,
      },
      200,
    );
  });

  app.openapi(setUserStatusRoute, async (c) => {
    const { userId } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const user = await deps.service.setUserStatus(userId, status);
    return c.json(
      { id: user.id, email: user.email, displayName: user.displayName, status: user.status },
      200,
    );
  });

  app.openapi(addMemberRoute, async (c) => {
    const input = c.req.valid("json");
    const membership = await deps.service.addMember({
      ...input,
      provisionedBy: c.get("internalClient")?.name,
    });
    return c.json(membership, 201);
  });

  // ── Firm administration. The tenant comes from the SESSION, so an admin can
  // only ever administer the firm they are acting for.
  app.openapi(listMembersRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const members = await deps.service.listMembers(s.tenantId);
    return c.json({ members: [...members] }, 200);
  });

  app.openapi(listColleaguesRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const colleagues = await deps.service.listColleagues(s.tenantId);
    return c.json(
      {
        colleagues: colleagues.map((p) => ({
          userId: p.userId,
          displayName: p.displayName,
          role: p.role,
          gradeName: p.gradeName,
          gradeRank: p.gradeRank,
        })),
      },
      200,
    );
  });

  app.openapi(inviteMemberRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const body = c.req.valid("json");
    // `staffInvite` and not `service` — the membership write is shared with the
    // portal invite, and the LETTER is the half that differs by why the
    // membership is being made. See `usecase/staffinvite/service.ts`.
    const added = await deps.staffInvite.add({ tenantId: s.tenantId, ...body }, s.actor);
    return c.json(
      {
        ...added.membership,
        invitationSent: added.invitationSent,
        invitationExpiresAt: added.invitationExpiresAt,
      },
      201,
    );
  });

  app.openapi(changeMemberRoleRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { membershipId } = c.req.valid("param");
    const { role } = c.req.valid("json");
    const membership = await deps.service.changeMemberRole(
      { tenantId: s.tenantId, membershipId, role },
      s.actor,
    );
    return c.json(membership, 200);
  });

  app.openapi(setMemberActiveRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { membershipId } = c.req.valid("param");
    const { isActive } = c.req.valid("json");
    const membership = await deps.service.setMemberActive(
      { tenantId: s.tenantId, membershipId, isActive },
      s.actor,
    );
    return c.json(membership, 200);
  });

  app.openapi(changeMemberGradeRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { membershipId } = c.req.valid("param");
    const { gradeId } = c.req.valid("json");
    const membership = await deps.service.changeMemberGrade(
      { tenantId: s.tenantId, membershipId, gradeId },
      s.actor,
    );
    return c.json(membership, 200);
  });

  app.openapi(setReportsToRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { membershipId } = c.req.valid("param");
    const { reportsToUserId } = c.req.valid("json");
    const membership = await deps.service.setReportsTo(
      { tenantId: s.tenantId, membershipId, reportsToUserId },
      s.actor,
    );
    return c.json(membership, 200);
  });

  app.openapi(firmSignatoryRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const signatory = await deps.service.firmSignatory(s.tenantId);
    return c.json({ signatory: signatory === null ? null : { ...signatory } }, 200);
  });

  app.openapi(setFirmSignatoryRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { userId, title } = c.req.valid("json");
    const signatory = await deps.service.setFirmSignatory(
      { tenantId: s.tenantId, userId, title },
      s.actor,
    );
    return c.json(
      { userId: signatory.userId, displayName: signatory.displayName, title: signatory.title },
      200,
    );
  });

  app.openapi(renameSelfRoute, async (c) => {
    const s = scopeOf(c.get("principal"));
    if (!s.ok) return c.json(s.deny, s.status);
    const { displayName } = c.req.valid("json");
    const user = await deps.service.renameSelf({ tenantId: s.tenantId, userId: s.userId, displayName }, s.actor);
    return c.json({ userId: user.id, displayName: user.displayName }, 200);
  });

  app.openapi(myMembershipsRoute, async (c) => {
    const principal = c.get("principal");
    if (!principal) {
      return c.json(
        toEnvelope({ status: 401, code: "UNAUTHORIZED", message: "no authenticated user" }),
        401,
      );
    }
    const memberships = await deps.service.resolveAccess(principal.userId);
    // ONE lookup for the whole list rather than one per row.
    const names = await deps.service.tenantNames(memberships.map((m) => m.tenantId));
    return c.json(
      {
        memberships: memberships.map((m) => ({
          ...m,
          tenantName: names.get(m.tenantId) ?? null,
        })),
      },
      200,
    );
  });
}

// Exported so a test can assert the spec (paths, methods) without booting a
// server — the routes are the contract.
export const tenancyRoutes = {
  createTenant: createTenantRoute,
  registerUser: registerUserRoute,
  addMember: addMemberRoute,
  myMemberships: myMembershipsRoute,
  listMembers: listMembersRoute,
  inviteMember: inviteMemberRoute,
  changeMemberRole: changeMemberRoleRoute,
  setMemberActive: setMemberActiveRoute,
  changeMemberGrade: changeMemberGradeRoute,
  setReportsTo: setReportsToRoute,
  firmSignatory: firmSignatoryRoute,
  setFirmSignatory: setFirmSignatoryRoute,
} as const;
