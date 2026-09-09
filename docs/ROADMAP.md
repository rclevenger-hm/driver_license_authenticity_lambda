# Identity screening pipeline roadmap

This roadmap starts from the repository's **current** implemented baseline rather than from the original synchronous prototype.

## Implemented baseline

The current system already includes:

- asynchronous intake through API Gateway -> intake Lambda -> S3 -> SQS -> worker Lambda;
- a dead-letter queue for failed work;
- DynamoDB-backed submission status and `GET /submissions/{submissionId}`;
- binary upload storage alongside submission metadata;
- optional Textract OCR when text is not supplied;
- driver-license and passport screening paths;
- PDF417/AAMVA-oriented barcode parsing inputs;
- API-key protection and API Gateway throttling;
- Terraform-managed AWS infrastructure;
- unit/smoke validation and documented operations/threat-model guidance.

The next work should therefore deepen reliability, reviewability, and screening evidence rather than re-adding capabilities that already exist.

## Priority 1 — idempotent intake and worker execution

Define a client-supplied or server-issued idempotency model so retries cannot create duplicate screening jobs accidentally. The worker should be safe under SQS at-least-once delivery and persist a processing/version key before final result publication.

Evidence required:

- duplicate intake request test;
- duplicate SQS delivery test;
- result-write idempotency test;
- documented retry behavior for ambiguous client/API failures.

## Priority 2 — bounded worker failure and redrive operations

Make DLQ handling an operator workflow rather than only an infrastructure component.

Add:

- failure classification in status records;
- alarms for queue age, DLQ depth, Lambda errors/throttles, and status records stuck in processing;
- a reviewed redrive procedure that checks whether a job is safe to replay;
- runbook examples for malformed document, downstream AWS failure, and code regression.

## Priority 3 — evidence provenance

Screening output should make clear which evidence came from user-supplied text, Textract, barcode parsing, image metadata, or deterministic validation. Persist source/provenance alongside findings so an analyst can explain why a result was produced.

Avoid presenting a numeric plausibility score as proof of document authenticity.

## Priority 4 — analyst review lifecycle

Add explicit review state transitions such as `unreviewed`, `in-review`, `confirmed`, `overridden`, and `closed`, including reviewer reason codes and timestamps. Keep machine screening status separate from human disposition.

This creates a calibration data set without silently training on every submitted document.

## Priority 5 — privacy and retention controls

Identity documents are sensitive data. Before a production deployment, define and enforce:

- S3 lifecycle/retention for originals, metadata, and results;
- DynamoDB retention/deletion behavior;
- encryption/KMS requirements;
- least-privilege read paths for analyst access;
- log redaction so base64 images, full OCR text, and sensitive fields do not appear in routine logs;
- deletion workflow that covers all copies/references for a submission.

## Priority 6 — deployment identity and release safety

Prefer short-lived CI deployment credentials (for example, GitHub OIDC into a narrowly scoped AWS role) instead of long-lived access keys. Keep application-runtime IAM separate from infrastructure-deployment IAM.

Add an environment promotion/release checklist that verifies queue/DLQ wiring, API-key requirement, throttling, status lookup, alarms, and a synthetic end-to-end submission before production traffic.

## Production-readiness evidence

The project should not claim production identity verification until it can show, at minimum:

- measured queue throughput and age under expected burst load;
- deterministic retry/idempotency behavior;
- DLQ/redrive exercises;
- status consistency through worker failure/retry;
- privacy/retention controls exercised end-to-end;
- documented false-positive/false-negative evaluation on reviewed representative data;
- clear legal/product wording that this is screening/plausibility support rather than authoritative identity proof.
