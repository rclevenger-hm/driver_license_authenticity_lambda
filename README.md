# Driver License Async Intake Pipeline

This project is now structured as an asynchronous intake system for driver's license screening.

Instead of trying to do everything in a single request, the API accepts a submission, stores it in S3, places a job on SQS, and lets a worker Lambda process the document in the background. That gives the project a much more production-friendly shape for retries, throughput spikes, and longer-running enrichment later.

When an image is included, the intake flow stores the original upload as a binary object in S3 and keeps the submission JSON as metadata plus references.

## Architecture

```text
Client
  -> API Gateway
  -> Intake Lambda
  -> S3 intake bucket (submission JSON)
  -> SQS screening queue
  -> Worker Lambda
  -> S3 results prefix (screening output JSON)
```

### Components

`intake-handler.js`
Receives API requests, validates the payload, writes the submission to S3, and enqueues a screening job.

`worker-handler.js`
Consumes SQS messages, loads the stored submission from S3, optionally runs Textract OCR when text is missing, runs the screening engine, and writes the result back to S3.

`screening.js`
Shared screening engine that scores OCR text and image metadata for plausibility.

`server.js`
Local HTTP wrapper around the intake handler for quick development.

## What the API does now

`POST /validate-license` no longer returns the screening decision immediately.

It now returns a queued job response like:

```json
{
  "submissionId": "7f5f2a6d-3d3e-4c26-9f44-efdf5dd6e6e9",
  "status": "queued",
  "submittedAt": "2026-04-12T12:00:00.000Z",
  "queue": "screening",
  "submissionLocation": "s3://driver-license-authenticity-intake/submissions/7f5f2a6d-3d3e-4c26-9f44-efdf5dd6e6e9.json",
  "resultLocation": "s3://driver-license-authenticity-intake/results/7f5f2a6d-3d3e-4c26-9f44-efdf5dd6e6e9.json"
}
```

The screening result is written by the worker Lambda to the `results/` prefix in the same bucket.

Submission status is also persisted in DynamoDB and can be retrieved through:

```text
GET /submissions/{submissionId}
```

The status record now keeps searchable operational fields such as `status`, `reviewStatus`, `lastUpdatedAt`, `processedAt`, `warningsCount`, `findingsCount`, and source-data hints for audit and queue monitoring.

All API Gateway routes are protected by an API key and attached to a throttled usage plan. Clients must send the `x-api-key` header when calling the deployed API.

## Request payload

Supported fields:

- `imageBase64`
- `image`
- `documentImageBase64`
- `ocrText`
- `text`
- `extractedText`
- `barcodeData`
- `pdf417Data`
- `metadata.stateCode`

At least one of `imageBase64` or `ocrText` is required.

Example request:

```bash
curl -X POST http://localhost:3000/validate-license \
  -H "Content-Type: application/json" \
  -d '{
    "imageBase64": "iVBORw0KGgoAAAANSUhEUgAAAlgAAAGQCAIAAAD9V4Q6AAAACXBIWXMAAAsSAAALEgHS3X78AAAAHUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAA4GEwQAABiwCo9QAAAABJRU5ErkJggg==",
    "ocrText": "DRIVER LICENSE CA DL NUMBER D1234567 DOB 01/02/1990 ISSUED 01/01/2020 EXPIRES 01/01/2028 ADDRESS 123 MAIN ST CLASS C"
  }'
```

## Screening behavior

The worker uses the shared screening engine to score document plausibility based on:

- Image type support for PNG, JPEG, and GIF
- Resolution and ID-card-like aspect ratio
- Suspiciously tiny payload size
- License-related OCR keywords
- Parsed AAMVA or PDF417 barcode payloads when available
- Presence of expected document fields
- U.S. state detection
- Basic date chronology checks

The result is a structured JSON object with:

- `status`: `pass`, `review`, or `reject`
- `score`: `0-100`
- `summary`
- `findings`
- `warnings`
- `imageAnalysis`
- `textAnalysis`
- `disclaimer`

This is still a plausibility screener, not a legal proof of authenticity.

## Local development

Install dependencies:

```bash
cd lambda_function
npm install
```

Run tests:

```bash
cd lambda_function
npm test
```

Run the local intake server:

```bash
cd lambda_function
set INTAKE_BUCKET_NAME=local-intake
set INTAKE_QUEUE_URL=http://localhost/fake-queue
npm start
```

Note:
The local server executes the intake handler, so without real AWS credentials and infrastructure it is mainly useful for request-shape testing. The unit tests cover the S3 and SQS interactions with mocked clients.

## AWS credentials

AWS credentials are not stored in this repository.

Before running Terraform or exercising the intake handler against real AWS services, configure credentials on your machine using one of these common paths.

### Option 1: `aws configure`

If you use long-lived access keys:

```bash
aws configure
```

You will be prompted for:

- AWS Access Key ID
- AWS Secret Access Key
- Default region name
- Default output format

Example:

```text
AWS Access Key ID [None]: AKIA...
AWS Secret Access Key [None]: ...
Default region name [None]: us-east-1
Default output format [None]: json
```

### Option 2: AWS SSO

If your organization uses AWS IAM Identity Center or AWS SSO:

```bash
aws configure sso
```

After you complete setup, authenticate with:

```bash
aws sso login
```

If you use a named profile, you can run Terraform with it like this:

```bash
$env:AWS_PROFILE="your-profile-name"
```

### Verify credentials

Before deploying, confirm that your local AWS CLI session is working:

```bash
aws sts get-caller-identity
```

That command should return your AWS account, user, or role identity.

### Important note

Do not put AWS secrets in this repository, in `terraform/config.json`, or in committed `.env` files. Use the AWS CLI credential store, environment variables, SSO, or an assumed role instead.

## Terraform deployment

Terraform provisions:

- An S3 bucket for submissions and results
- An SQS queue plus dead-letter queue
- A DynamoDB table for submission status
- An intake Lambda
- A worker Lambda
- A status lookup Lambda
- An event source mapping from SQS to the worker
- API Gateway for the intake endpoint
- IAM roles and policies for each Lambda

Terraform also runs `npm ci --omit=dev` in `lambda_function/` before packaging so the Lambda bundle includes the AWS SDK clients it depends on.
The stack now supports configurable name suffixes, resource tags, S3 retention rules, and CloudWatch log retention settings through `terraform/config.json`.

Before deploying:

1. Install Terraform.
2. Configure AWS credentials using the section above.
3. Review and customize `terraform/config.json`, especially the bucket and function names.

Deploy:

```bash
cd terraform
terraform init
terraform apply
```

Destroy:

```bash
cd terraform
terraform destroy
```

## Project layout

`lambda_function/`
Application code, AWS handlers, local server, and tests.

`terraform/`
AWS infrastructure for the async pipeline.

## Good next steps

The next high-value upgrades would be:

1. Add a status lookup endpoint so clients can retrieve results by `submissionId`.
2. Store original binary uploads instead of only a JSON envelope when images are posted to the API.
3. Add Textract, Rekognition, or another OCR stage before scoring.
4. Parse PDF417 barcodes for AAMVA-compatible licenses.
5. Persist analyst review feedback to calibrate scoring over time.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
