const { CloudTasksClient } = require('@google-cloud/tasks');

class GenAiQueueService {
  constructor() {
    this.client = new CloudTasksClient();
  }

  async enqueueGenAi(payload) {
    const {
      GCLOUD_PROJECT,
      GCLOUD_LOCATION,
      GCLOUD_SERVICE_ACCOUNT_EMAIL
    } = process.env;

    const parent = this.client.queuePath(
      GCLOUD_PROJECT,
      GCLOUD_LOCATION,
      'genai-validation'
    );

    const body = Buffer
      .from(JSON.stringify(payload))
      .toString('base64');

    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url:'https://hunchgenaitest-320866101884.us-central1.run.app/genai-validation-worker', // 👇 new worker api
        headers: {
          'Content-Type': 'application/json'
        },
        body,
        oidcToken: {
          serviceAccountEmail: GCLOUD_SERVICE_ACCOUNT_EMAIL,
          audience: new URL('https://hunchgenaitest-320866101884.us-central1.run.app/genai-validation-worker').origin
        }
      }
    };

    const [response] = await this.client.createTask({ parent, task });
    return response;
  }

  async enqueueGenAiBatch() {
    const {
      GCLOUD_PROJECT,
      GCLOUD_LOCATION,
      GCLOUD_SERVICE_ACCOUNT_EMAIL
    } = process.env;

    const parent = this.client.queuePath(
      GCLOUD_PROJECT,
      GCLOUD_LOCATION,
      'genai-validation'
    );

    const baseUrl = 'https://hunchgenaitest-320866101884.us-central1.run.app';
    const workerUrl = `${baseUrl}/genai-batch-worker`;

    const body = Buffer
      .from(JSON.stringify({ trigger: 'ml_complete', timestamp: new Date().toISOString() }))
      .toString('base64');

    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url: workerUrl,
        headers: {
          'Content-Type': 'application/json'
        },
        body,
        oidcToken: {
          serviceAccountEmail: GCLOUD_SERVICE_ACCOUNT_EMAIL,
          audience: new URL(workerUrl).origin
        }
      }
    };

    const [response] = await this.client.createTask({ parent, task });
    return response;
  }
}

module.exports = new GenAiQueueService();
