const { CloudTasksClient } = require('@google-cloud/tasks');

class GCloudService {
  constructor() {
    this.tasksClient = new CloudTasksClient();
  }

  async queueTraitTasks(rawResults, projectId, modelFileName, type) {
    const {
      GCLOUD_PROJECT,
      GCLOUD_LOCATION,
      GCLOUD_QUEUE_TRAITS,
      ML_CALLBACK_BASE,
      GCLOUD_SERVICE_ACCOUNT_EMAIL,
    } = process.env;
    console.log(  GCLOUD_PROJECT,
        GCLOUD_LOCATION,
        GCLOUD_QUEUE_TRAITS,
        ML_CALLBACK_BASE,
        GCLOUD_SERVICE_ACCOUNT_EMAIL,)

    const parent = this.tasksClient.queuePath(
      GCLOUD_PROJECT,
      GCLOUD_LOCATION,
      GCLOUD_QUEUE_TRAITS
    );

    const payload = {
      model_filename: modelFileName,
      project_id: projectId.toString(),
      cb_url: 'https://hunchgenaitest-320866101884.us-central1.run.app/trait-prediction',
      type: type,
      data: rawResults,
    };
    // body must be base64-encoded string
    const body = Buffer.from(JSON.stringify(payload)).toString('base64');

   
		const task = {
			httpRequest: {
				url: 'https://us-central1-hunch-ai.cloudfunctions.net/ml-trait-prediction-stage',
				body,
				headers: {
					'Content-Type': 'application/json', // required or Cloud Function will just run as string
				},
				oidc: {
					serviceAccountEmail: process.env.GCLOUD_SERVICE_ACCOUNT_EMAIL,
					audience: new URL(
						'https://us-central1-hunch-ai.cloudfunctions.net/ml-trait-prediction-stage',
					).origin,
				},
			},
		};
// console.log('task',task)
    const request = { parent, task };
    const [response] = await this.tasksClient.createTask(request);
    console.log('===============request=================')

    // console.log(request)
    console.log('===============response=================')
    // console.log(response)
    return response;
  }

  cleanText(text) {
    if (!text) return '';
    // Remove extra whitespace and trim
    return text.replace(/\s+/g, ' ').trim();
  }
}

module.exports = GCloudService;
