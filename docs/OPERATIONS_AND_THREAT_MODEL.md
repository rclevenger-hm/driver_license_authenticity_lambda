# Identity pipeline operations and threat model

This document describes how the asynchronous identity-document screening pipeline should be reasoned about operationally. It is intentionally limited to the public architecture in this repository and does not claim that the plausibility score is proof of identity or document authenticity.

## System boundary

```text
Untrusted client
  -> API Gateway + API key + throttling
  -> Intake Lambda
  -> private S3 objects (submission metadata + uploaded image)
  -> SQS screening queue
  -> Worker Lambda / optional Textract
  -> private S3 result object
  -> DynamoDB status record
  -> Status Lambda / API Gateway
```

The highest-sensitivity data is the submitted identity-document image and extracted document text. Both should be treated as personal data even when the screening result itself is low risk.

## Current controls represented in Terraform

The current infrastructure already encodes several useful safety properties:

- S3 public access is blocked at the bucket level.
- S3 objects use server-side encryption with AES-256.
- Submission and result prefixes have explicit retention periods rather than indefinite storage.
- API Gateway routes require an API key and are attached to a throttled usage plan.
- Screening work is asynchronous through SQS, with a dead-letter queue after repeated failures.
- Lambda execution is split into intake, worker, and status roles instead of one shared runtime role.
- CloudWatch log retention is configurable rather than implicitly infinite.

These are useful controls, but they do not by themselves make the system suitable for regulated identity verification.

## Trust boundaries and primary risks

### 1. Client -> API Gateway

**Threats**
- oversized or malformed requests
- automated abuse / cost amplification
- replayed submissions
- accidental exposure of API keys

**Controls / expectations**
- validate payload shape before persistence
- bound image/request size
- use API Gateway throttling as a coarse abuse control, not as authentication
- rotate and scope API keys if they are used outside development
- avoid putting submitted document content in access logs

### 2. Intake Lambda -> S3 / SQS

**Threats**
- partial intake where an object is written but a job is not queued
- queue messages referring to missing or malformed objects
- over-broad IAM permissions

**Controls / expectations**
- preserve a submission ID across storage, queue, result, and status records
- make retries safe for the same submission ID
- keep IAM actions limited to the specific bucket, queue, and table resources required by each Lambda
- treat S3 as the durable intake record and SQS as delivery, not the source of truth

### 3. Worker -> OCR / screening -> results

**Threats**
- poison jobs repeatedly failing
- OCR service failures or throttling
- malformed or adversarial image/text inputs
- false confidence from a heuristic score

**Controls / expectations**
- failed jobs move to the DLQ after the configured retry count
- screening results retain warnings/findings so operators can understand why a document was classified
- user-facing integrations should preserve the repository's disclaimer that this is a plausibility screener
- downstream systems should not convert `pass` into a legal identity-verification assertion

### 4. Results / status retrieval

**Threats**
- enumeration of submission IDs
- exposing another user's result
- retaining sensitive data longer than operationally necessary

**Controls / expectations**
- production deployments need caller-level authorization beyond knowledge of a submission ID
- avoid exposing S3 object locations as bearer-style access mechanisms
- keep retention periods aligned with the actual product need and applicable policy

## Data lifecycle

The Terraform configuration currently separates retention policy by prefix:

- submissions: short-lived intake data
- results: longer-lived screening output
- logs: independently configurable CloudWatch retention

Before production use, explicitly answer:

1. What business need justifies retaining the original image?
2. What is the shortest acceptable retention period?
3. Is deletion required on user request or workflow completion?
4. Should results contain extracted PII, or only derived findings?
5. Is AWS-managed encryption sufficient for the intended data classification, or is a customer-managed KMS key required?

## Operational signals

At minimum, operators should be able to answer these questions from metrics/logs without opening individual document payloads:

- How many submissions are accepted per minute?
- How old is the oldest visible SQS message?
- How many messages are in the DLQ?
- What fraction of jobs fail or retry?
- How long does queue-to-result processing take?
- What fraction of results are `pass`, `review`, or `reject`?
- Are Textract errors or throttles increasing?
- Are status lookups returning elevated 4xx/5xx rates?

Avoid using raw OCR text, names, license numbers, addresses, or document images as routine observability dimensions.

## DLQ incident runbook

### Trigger

Investigate when the screening DLQ contains messages or the worker failure/retry rate materially increases.

### Triage

1. Confirm whether failures began after a deployment or configuration change.
2. Check worker Lambda errors and throttles.
3. Check S3 read/write errors and whether referenced submission objects exist.
4. Check Textract failures if OCR is enabled.
5. Inspect one representative failed message by submission ID; avoid copying document payloads into tickets or chat.
6. Determine whether failures are deterministic for a specific input or systemic across jobs.

### Containment

- If a deployment caused the failure, roll back before replaying messages.
- If an external AWS dependency is impaired, leave messages in the DLQ until the dependency is healthy.
- If a malformed input repeatedly poisons the worker, preserve the failure evidence and do not blindly replay it.

### Recovery

Only redrive messages after the underlying failure mode is understood and corrected. Reprocessing must be idempotent for a submission ID so an operator cannot accidentally create conflicting result/status records.

### Verify

After redrive:

- queue depth trends downward
- no new DLQ messages accumulate
- representative submissions reach a terminal status
- processing latency returns to baseline
- no duplicate or conflicting result records appear

### Post-incident

Capture the failure mode, detection gap, recovery action, and whether a new automated assertion/metric/runbook step can prevent recurrence.

## Production-readiness gaps

Before presenting this as a production identity-verification service, evaluate at least:

- caller authentication and per-submission authorization
- KMS/customer-managed encryption requirements
- secrets/API-key lifecycle
- WAF/request-size protections
- audit logging that avoids PII leakage
- deletion/retention policy and regulatory obligations
- alarms for queue age, DLQ depth, Lambda failures, and API error rates
- idempotency guarantees for retries/redrives
- dependency failure behavior for Textract
- formal validation of IAM least privilege

The repository is strongest when these boundaries are explicit: it demonstrates an asynchronous, testable screening pipeline without overstating what the screening result proves.
