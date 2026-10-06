# Identity Document Async Intake Pipeline

An AWS Lambda service for asynchronous driver-license and passport plausibility
screening. It stores submissions in S3, dispatches work through SQS, processes it
with a leased worker, and exposes caller-owned status in DynamoDB.

The screening engine checks image metadata, document keywords, basic dates, and
supplied AAMVA/PDF417 text. It can use Textract when an image has no supplied OCR
text. Its score is a heuristic, not proof of identity, authenticity, or issuance.

## API contract

Both routes require an **IAM-signed request** and the `x-api-key` header. Grant
clients the policy from `terraform output -raw client_invoke_policy`. Separate
consumers need separate IAM users or roles; role sessions share ownership.

- `POST /validate-license`: submit a document with an `Idempotency-Key` header.
- `GET /submissions/{submissionId}`: retrieve only the caller's own submission.

Use the same idempotency key and payload when retrying an ambiguous request.
A conflicting payload returns 409. Foreign, missing, and ownerless submissions
return the same 404 response. Internal S3 locations and lease details are not
returned by the API.

Example body:

```json
{
  "documentType": "driver-license",
  "imageBase64": "<base64-encoded image>",
  "ocrText": "<optional supplied document text>",
  "metadata": { "stateCode": "CA" }
}
```

Supported document types are `driver-license` and `passport`. At least one of
`imageBase64`, `ocrText`, or `barcodeData` is required. Existing aliases `image`,
`documentImageBase64`, `text`, `extractedText`, and `pdf417Data` remain supported.
Request bodies are limited to 5 MiB before storage.

An accepted submission returns HTTP 202:

```json
{
  "submissionId": "<64-character submission ID>",
  "status": "queued",
  "submissionType": "driver-license",
  "submittedAt": "2026-10-06T00:00:00.000Z",
  "lastUpdatedAt": "2026-10-06T00:00:00.000Z",
  "statusEndpoint": "/submissions/<submission ID>"
}
```

A response can instead report `dispatch_pending` when data is durably accepted
but enqueueing needs recovery. A scheduled reconciler retries automatically.
Status progresses through `queued`, `processing`, and `completed`, with `retrying`
and `failed` for processing failures. `reviewStatus` separately contains the
screening engine's `pass`, `review`, or `reject` result. A completed replay returns
HTTP 200 and the original submission ID.

## Reliability

- Immutable S3 objects and conditional DynamoDB creation isolate concurrent
  submissions using the same key.
- Pending dispatch records survive SQS outages and ambiguous enqueue responses.
- Conditional leases prevent concurrent workers from publishing conflicting
  results; completed deliveries are acknowledged without reprocessing.
- SQS partial batch responses preserve failed work for retry and DLQ handling.
- Workers load resource locations from trusted configuration and durable state.
- IAM permissions explicitly cover upload writes and reads under `uploads/`.
- Upload/submission/result lifecycle rules include noncurrent object expiration.

Read [reliability, authentication, migration, and AWS verification](docs/RELIABILITY_AND_ACCESS.md)
before upgrading an existing deployment. This release requires client and queue
migration; old ownerless submissions are not automatically exposed.

## Development

Use Node.js 22, matching the deployed runtimes and CI:

```bash
cd lambda_function
npm ci
npm test
npm run smoke
```

Tests use a local DynamoDB emulator and mock S3/SQS transports. They cover intake,
concurrency, idempotency, failure recovery, processing leases, and caller access.
The smoke command runs the owned intake-to-status flow without AWS credentials.

The optional HTTP wrapper (`npm start`) binds to loopback. To use it against a
development AWS stack, configure `INTAKE_BUCKET_NAME`, `INTAKE_QUEUE_URL`, and
`SUBMISSION_TABLE_NAME`, plus an explicit `LOCAL_CALLER_ARN` such as
`arn:aws:iam::111122223333:user/local-developer`. This is a fixed development
identity, not authentication. Without it, requests fail closed. Never expose this
wrapper as a public gateway. HTTP clients must still send `Idempotency-Key`.

## Deployment

Configure AWS credentials through a named profile or IAM Identity Center. Never
commit credentials, API-key values, document images, or real OCR text.

Review `terraform/config.json` for unique names, region, environment tags,
retention, throttling, and alarm routing. Then:

```bash
cd terraform
terraform init
terraform fmt -check -recursive
terraform validate
terraform test
terraform plan
terraform apply
```

Terraform 1.7 or newer is required for the mock-provider tests. The deployment
packages production dependencies and provisions API Gateway, four Lambdas
(intake, worker, status, and reconciliation), private S3 storage, DynamoDB,
SQS/DLQ, scheduled dispatch, IAM policies, alarms, and an operations dashboard.
Application dependencies are installed with `npm ci --omit=dev` before packaging;
run `npm ci` again before running local tests afterward.

A real upload/retry/DLQ verification harness is available through `npm run verify:aws`.
See the [isolated-stack instructions](docs/RELIABILITY_AND_ACCESS.md#live-aws-verification).
It requires AWS credentials and takes roughly 30 minutes to exercise retry exhaustion.

## Documentation

- [Documentation index](docs/README.md)
- [Reliability and access](docs/RELIABILITY_AND_ACCESS.md)
- [Operations and threat model](docs/OPERATIONS_AND_THREAT_MODEL.md)
- [Roadmap](docs/ROADMAP.md)

## License

[MIT](LICENSE).
