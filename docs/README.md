# Operations documentation

The application README describes the request flow, local development, and Terraform deployment. These documents focus on how the system should be operated and reviewed as an asynchronous workload that handles sensitive identity-document data.

- [Operations and threat model](OPERATIONS_AND_THREAT_MODEL.md) — trust boundaries, current Terraform controls, PII lifecycle, operational signals, DLQ recovery, and production-readiness gaps.

## Current next engineering steps

The repository already includes asynchronous intake, binary S3 uploads, SQS worker processing, DynamoDB status lookup, optional Textract OCR, and PDF417/AAMVA parsing. The next useful work is therefore operational hardening rather than re-implementing those capabilities:

1. Add CloudWatch alarms for worker errors, oldest-message age, and DLQ depth.
2. Make retry/redrive idempotency explicit and test duplicate job delivery.
3. Evaluate per-submission authorization for result retrieval beyond API-key possession.
4. Decide whether customer-managed KMS encryption is required for the intended data classification.
5. Add an explicit deletion workflow and verify retention behavior for sensitive document uploads.

These steps keep the project honest about its current scope: a plausibility-screening pipeline with production-oriented architecture, not a legal identity-verification service.
