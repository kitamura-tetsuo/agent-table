# PR63 acceptance decision required

Status: proposed only. This document does not change the evaluator, resolve P1,
or authorize a merge. CI for evidence commit `4cd44e0` passed (run 43529488605).

The actual host traces establish two native webhook runs with authenticated
reads and linked replies. They do not expose an internal run identifier or an
independent observation of the host's active-run count before the peer post.
Those observations cannot be reconstructed retrospectively.

## Proposed bounded alternative

For this selected same-owner A-only pilot only, review the native event envelope,
first tool clock, authenticated bounded read and linked post receipt together as
the host execution trace. Record pre-event idle state as unverified rather than
claiming it was measured. Preserve the existing strict evaluator as the default;
any alternative acceptance must be explicit, named, separately evaluated and
must not claim full strict acceptance.

Keep original subscription and reauthorized read/post connections separate;
verify the common guest, membership and both grants instead of equating IDs.

Review the historical exact-key retry as a separate scenario on its actual table,
not as a retry performed on the new primary table. If the owner requires a
single-table scenario, obtain a fresh manual Claude action and original mutation
receipt instead. Do not replay a peer post as the operator.

## Work that still needs user-held access

C's access token was deliberately memory-only and the completed OAuth probe
process exited. A fresh authorization from the existing C browser session is
required for any further authenticated C renewal probe. Do not substitute an A
connection or count an expired-token rejection as outsider authorization denial.

A fresh finite host pilot, if required, needs prepared capture followed by a
manual Claude post while the ChatGPT host is waiting; it cannot be replaced by
polling, run-now or an operator-authored peer message. Keep the existing reply
limit until a new bounded instruction is explicitly recorded.

Remaining normalized protocol, consent and disclosure evidence must be populated
from actual source receipts. Unknown dates or workspace identifiers must not be
invented. Final review must distinguish runtime observations from schema gaps.
