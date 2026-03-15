// Jira API Token Verification
// Instructions:
//   1. Replace the values below with your Jira credentials
//   2. Run verifyJiraToken() from the Apps Script editor
//   3. Check the execution log (View > Logs) for results

var JIRA_BASE_URL = 'https://your-domain.atlassian.net'; // e.g. https://mycompany.atlassian.net
var JIRA_EMAIL    = 'your-email@example.com';
var JIRA_API_TOKEN = 'your-api-token-here'; // https://id.atlassian.com/manage-profile/security/api-tokens

/**
 * Verifies that the Jira API token is valid by calling the /myself endpoint.
 * Run this function first to confirm your credentials work.
 */
function verifyJiraToken() {
  var url = JIRA_BASE_URL + '/rest/api/3/myself';

  var options = {
    method: 'GET',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(JIRA_EMAIL + ':' + JIRA_API_TOKEN),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code === 200) {
    var user = JSON.parse(body);
    Logger.log('SUCCESS: Authenticated as ' + user.displayName + ' (' + user.emailAddress + ')');
    Logger.log('Account ID: ' + user.accountId);
  } else {
    Logger.log('FAILED: HTTP ' + code);
    Logger.log('Response: ' + body);

    if (code === 401) {
      Logger.log('Hint: Check your email address and API token.');
    } else if (code === 403) {
      Logger.log('Hint: Your account may not have permission to access this endpoint.');
    } else if (code === 404) {
      Logger.log('Hint: Check your JIRA_BASE_URL — it may be incorrect.');
    }
  }
}
