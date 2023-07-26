# Driver's License Authenticity Validation Lambda

This AWS Lambda function validates the authenticity of driver's licenses through image processing and verification.

## Prerequisites

Before deploying the Lambda function, ensure you have the following:

1. AWS CLI installed and configured with appropriate credentials.
2. Node.js and npm installed for development.

## Deployment

1. Clone the repository:

```bash
git clone <repository-url>
cd driver_license_authenticity_lambda
```

2. Install dependencies:

```bash
cd lambda_function
npm install
cd ..
```

3. Configure `config.json`:

Edit the `config.json` file with your preferred settings, including the AWS region, Lambda function name, API Gateway name, and API resource path.

4. Build the Lambda function package:

```bash
cd lambda_function
zip -r ../lambda_function.zip .
cd ..
```

5. Deploy the Lambda function and API Gateway:

```bash
terraform init
terraform apply
```

## Testing

To run the unit tests, ensure you have installed the required dependencies:

```bash
cd lambda_function
npm install --only=dev
cd ..
```

Then, run the tests:

```bash
npm test
```

## Usage

To use the Lambda function, make a POST request to the API Gateway endpoint with the base64-encoded image data of the driver's license.

Example using cURL:

```bash
curl -X POST -H "Content-Type: application/json" -d '{"image": "base64-encoded-image-data"}' <API-GATEWAY-URL>/validate-license
```

Replace `base64-encoded-image-data` with the actual base64-encoded image data of the driver's license.

## Cleanup

To remove the Lambda function and API Gateway resources, run:

```bash
terraform destroy
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.