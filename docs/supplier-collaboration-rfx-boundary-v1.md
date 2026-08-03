# Supplier Collaboration and RFX Boundary v1

## Status

Architecture boundary only. This document defines future domain ownership and identity separation. It does not authorize implementation in PR #19.

## Domain scope

Future supplier collaboration must model a sourcing lifecycle rather than extend the current RFQ read surface with ad hoc fields. The target vocabulary is:

| Concept | Responsibility |
| --- | --- |
| RFI | Collect structured supplier information before commercial solicitation. |
| RFP | Collect solution, service, technical, and commercial proposals. |
| RFQ | Collect comparable price, quantity, delivery, and commercial terms. |
| Sourcing Event | Own lifecycle, lots/lines, deadlines, participation rules, and evaluation policy across an RFI, RFP, or RFQ. |
| Supplier Invitation | Invite an external supplier organization and named contacts to one sourcing event. |
| Supplier Portal | Provide a tenant-isolated external surface for invited supplier users. |
| Supplier Response | Store the supplier's versioned response to event requirements and lines. |
| Quote Revision | Preserve immutable commercial revisions and supersession history. |
| Clarification | Record buyer-supplier questions, answers, visibility, deadlines, and audit evidence. |
| Evaluation | Apply declared qualitative and quantitative criteria without silently awarding. |
| Award | Record an explicit internal decision and its selected response/lines after authorized review. |

## Aggregate and lifecycle direction

A future `SourcingEvent` should own its event type (`RFI`, `RFP`, or `RFQ`), state, lines/lots, deadlines, evaluation policy, and invitation set. Supplier responses belong to an invitation and event; revisions append new versions rather than overwriting submitted commercial facts. Clarifications are separately auditable conversations. Evaluation output is evidence for an award decision, not the award itself.

An indicative lifecycle is:

```text
internal draft
→ internal approval to publish
→ supplier invitations issued
→ supplier participation accepted or declined
→ responses and revisions submitted before close
→ clarifications resolved
→ event closed
→ evaluation reviewed
→ authorized award decision
→ downstream procurement draft
```

No AI component may advance this lifecycle directly. AI may summarize, compare, explain, or prepare a reviewable draft; authorized users and business command policies own publication, submission acceptance, evaluation approval, and award.

## Internal and external identity separation

The existing `WorkspaceInvitation` represents invitation into an internal FlowChain tenant workspace.

```text
Internal WorkspaceInvitation
≠
Future Supplier Portal Invitation
```

A supplier portal invitation must be a separate domain object with its own event scope, supplier organization, contact, expiration, acceptance state, revocation state, and audit evidence. It must not grant internal workspace membership.

External supplier identities must not reuse internal roles such as `admin`, `manager`, `buyer`, `viewer`, or `business-specialist`. A future external identity model needs a separate principal type, session boundary, permission vocabulary, and tenant/supplier/event scope. Supplier users may only view and act on invitations and responses explicitly granted to their supplier organization.

## Security and audit requirements

- External sessions must use a distinct authentication and revocation boundary from internal workspace sessions.
- Invitation tokens must be single-purpose, expiring, hashed at rest, and non-replayable after acceptance or revocation.
- Every response submission, revision, clarification, and withdrawal must preserve actor, supplier organization, event, timestamp, and version.
- Buyer-only evaluation content and competing supplier responses must never be visible to supplier principals.
- Award authority remains an internal permission and business command, with explicit confirmation and audit.
- Email delivery is transport, not proof of authorization or acceptance.

## Explicitly out of scope for PR #19

- Supplier login or external sessions
- Email invitations
- Supplier quote submission
- New RFX mutations
- Supplier Portal pages
- Prisma models or migrations
- Changes to internal `WorkspaceInvitation`

These capabilities require a dedicated product phase, threat model, data model review, migration plan, API contract, and end-to-end authorization tests.
