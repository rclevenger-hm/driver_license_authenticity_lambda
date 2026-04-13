# Driver License Plausibility Screening Lambda

This project has been revived into a working AWS Lambda and local HTTP service that performs first-pass screening for driver's license submissions.

It does not claim to prove legal authenticity. Instead, it helps an intake pipeline decide whether a submission looks plausible enough to pass, should be manually reviewed, or should be rejected before more expensive checks happen.

## What it does

The service accepts OCR text, base64-encoded image data, or both, and returns:

- A `score` from 0 to 100
- A `status` of `pass`, `review`, or `reject`
- Positive `findings`
- Risk `warnings`
- Image metadata such as format, size, and dimensions when available
- A plain-language `summary`

## Screening logic

The Lambda currently checks for:

- Image file type support for PNG, JPEG, and GIF
- Resolution and aspect ratio that resemble an ID card photo
- Tiny or suspiciously small image payloads
- Common driver's license keywords in OCR text
- Presence of expected fields such as DOB, issue date, expiration date, address, class, and ID number
- Detection of a U.S. state code
- Basic chronology sanity checks across detected dates

This makes the project useful as a low-cost fraud triage layer, a preprocessing step before manual review, or a guardrail ahead of DMV or vendor verification.

## Project layout

`lambda_function/`
Runtime code, local server, and tests.

`terraform/`
Infrastructure for packaging the Lambda, creating an execution role, and exposing the function through API Gateway.

## Local usage

The project uses only Node's built-in modules, so there are no external runtime dependencies to install.

Run tests:

```bash
cd lambda_function
npm test
```

Run a local server:

```bash
cd lambda_function
npm start
```

The local endpoint will be available at:

```text
POST http://localhost:3000/validate-license
```

Example request:

```bash
curl -X POST http://localhost:3000/validate-license \
  -H "Content-Type: application/json" \
  -d '{
    "imageBase64": "iVBORw0KGgoAAAANSUhEUgAAAlgAAAGQCAIAAAD9V4Q6AAAACXBIWXMAAAsSAAALEgHS3X78AAAAHUlEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAA4GEwQAABiwCo9QAAAABJRU5ErkJggg==",
    "ocrText": "DRIVER LICENSE CA DL NUMBER D1234567 DOB 01/02/1990 ISSUED 01/01/2020 EXPIRES 01/01/2028 ADDRESS 123 MAIN ST CLASS C"
  }'
```

Example response:

```json
{
  "status": "pass",
  "score": 100,
  "summary": "Pre-screen passed with score 100. The submission looks plausible, but should still be verified against official or manual checks.",
  "findings": [
    "Image format detected as png.",
    "Image resolution is sufficient for a first-pass review."
  ],
  "warnings": [],
  "disclaimer": "This service performs document plausibility screening only. It does not confirm legal authenticity or DMV issuance."
}
```

## Lambda event formats

The handler supports either:

- Direct invocation with a JSON object containing `imageBase64` and or `ocrText`
- API Gateway proxy events with a JSON `body`

Supported payload fields:

- `imageBase64`
- `image`
- `documentImageBase64`
- `ocrText`
- `text`
- `extractedText`
- `metadata.stateCode`

## Deploy with Terraform

Terraform packages the `lambda_function/` directory, creates an IAM execution role, provisions the Lambda, and exposes a `POST /validate-license` API Gateway route.

Before deploying:

1. Install Terraform.
2. Configure AWS credentials for the target account.
3. Review `terraform/config.json`.

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

## Docker

Run the local server with Docker Compose:

```bash
docker compose up --build
```

## Good next steps

If you want to keep investing in this project, the most valuable additions would be:

1. Plug in a real OCR stage such as Textract or Rekognition upstream.
2. Add barcode or PDF417 parsing for AAMVA-compliant licenses.
3. Introduce state-specific field validation rules.
4. Persist screening results for analyst review and feedback loops.
5. Add confidence calibration with real sample documents.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
