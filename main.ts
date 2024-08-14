/*
(c) Copyright 2024 Akamai Technologies, Inc. Licensed under Apache 2 license.
Purpose: some testing with subworkers
More info regarding subworkers: https://techdocs.akamai.com/edgeworkers/docs/create-a-subworker
*/

import { httpRequest } from "http-request";
import URLSearchParams from "url-search-params";
import { createResponse } from "create-response";
import { logger } from "log";

/*
some 'unsafe' headers we need to remove. httpRequest will fail if not removed
https://techdocs.akamai.com/edgeworkers/docs/http-request#http-sub-requests
https://github.com/akamai/edgeworkers-examples/blob/master/edgecompute/examples/stream/find-replace-stream/main.js
*/
const headersToRemove = [
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "vary",
  "accept-encoding",
  "content-encoding",
  "keep-alive",
  "Proxy-Authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "upgrade",
];

// our statically defined username and password field we're expecting the the POST body
const UNAME = "username";
const PASSWD = "password";

// our key generating and know password lookup
const KEYGENERATOR_URL = "https://api.grinwis.com/NoMoreLeaksKey";
const KNOWNKEY_URL = "https://api.grinwis.com/KnownKey";

// Macrometa collection we're going to use
const COLLECTION = "NoMoreLeaks";

// the field that contains our key
const KEY = "key";

// define the body we're going to send to our key generator endpoint
// based on on the key request endpoint this can be changed.
interface KeyRequestBody {
  uname: string;
  passwd: string;
}

// define out bindvars we're going to feed in our Macrometa query worker
interface BindVars {
  "@collection": string;
  key: string;
}

// as we need  some info from the request body, we have to use the responseProvider
export async function responseProvider(request: EW.ResponseProviderRequest) {
  // get the body of the request. We know the payload is not too large so we should be fine with the standard limits
  // https://techdocs.akamai.com/edgeworkers/docs/resource-tier-limitations
  let body = await request.json().catch(() => null);

  // by default our key is false, so in case anything goes wrong, just allow this call.
  let knownKey: Boolean = false;

  // Using intermediate variables to clean up our if statement. Thanks ChatGPT.
  const hasBody = body !== null;
  const hasCredentials = hasBody && UNAME in body && PASSWD in body;
  const bodyIsValid =
    hasCredentials && body[UNAME].length > 1 && body[PASSWD].length > 2;

  // only start process if we have a body and the required fields.
  // testing with some intermediate variables, let's see how that is working.
  if (bodyIsValid) {
    // Looks like we have all the required fields, feed it into our var.
    var requestBody: KeyRequestBody = {
      uname: body[UNAME],
      passwd: body[PASSWD],
    };

    // now try to call our key generating endpoint, response will be valid key or null
    const key = await getKeyFromKeyGenerator(requestBody);

    if (key) {
      // if we have some key, create our query string.
      // this version of our MacroMeta Query Worker is using a query string
      const queryString: BindVars = {
        "@collection": COLLECTION,
        key: key,
      };
      // now call our endpoint to check if key exists
      knownKey = await keyExists(queryString);
    }
  }

  // forward request to origin, await the response
  const originResponse = await originRequest(request, body, knownKey);
  logger.info(`Origin response: ${originResponse.status}`);

  // if we have a hit, show our "no-more-leaks" page
  // for now just serving some very simple message.
  if (knownKey && originResponse.ok) {
    return Promise.resolve(
      createResponse(
        200,
        { "Powered-By": ["Akamai EdgeWorkers - No More Leaks Module"] },
        "<html><body><p>Something wrong with your account, Please contact helpdesk.</p></body></html>"
      )
    );
  }

  if (originResponse.ok) {
    return Promise.resolve(
      createResponse(
        originResponse.status,
        originResponse.getHeaders(),
        originResponse.body
      )
    );
  } else {
    // just return a rejected promise if to origin has failed, not reporting it to external system
    return Promise.reject(`failed sub-request: ${originResponse.status}`);
  }
}

// chatGPT advised us to create a separate function to check our result
async function getKeyFromKeyGenerator(
  requestBody: any
): Promise<string | null> {
  try {
    const result = await httpRequest(KEYGENERATOR_URL, {
      method: "POST",
      body: JSON.stringify(requestBody),
    });

    if (result.ok) {
      const response = await result.json();

      logger.info(
        `Endpoint generated a key: ${response[KEY].substring(0, 5)}.....`
      );

      // let's return our generated key
      return response[KEY];
    } else {
      logger.error(
        `Request to ${KEYGENERATOR_URL} failed with status: ${result.status}`
      );
    }
  } catch (error) {
    logger.error(`There was a problem calling ${KEYGENERATOR_URL}: ${error}`);
  }

  // if anything goes wrong, just respond with null
  return null;
}

// use our endpoint to check if this key exists.
// this specific endpoint required a GET and is using a query string with the parameters.
async function keyExists(bindvars: object): Promise<boolean> {
  // we can't just use:
  // - new URLSearchParams({ bindVars: JSON.stringify(bindvars) }).toString();
  // we can only feed a string into URLSearchParams. So first create a new object and use append
  // be aware to spell bindVars with capital V, won't work otherwise!
  const queryString = new URLSearchParams();
  queryString.append("bindVars", JSON.stringify(bindvars));

  // no need to do a toString() on our URLSearchParams object.
  // looks like httpRequest knows ho to deal with it.
  const url = `${KNOWNKEY_URL}?${queryString}`;

  try {
    const result = await httpRequest(url, {
      method: "GET",
    });

    // this will call our macrometa subWorker which will respond with
    if (result.ok) {
      /*
        A successful response in this case looks like this:
        [{"result":false}]
     */
      const response = await result.json();
      logger.info(`key exists: ${JSON.stringify(response[0]["result"])}`);
      // our endpoint should just return a true or false that it.
      return response[0]["result"];
    } else {
      // if there is some error, just get the error string and log it
      const errorResponse = await result.json();
      logger.error(`Request to ${url} failed with status: ${errorResponse}`);
    }
  } catch (error) {
    logger.error(`There was a problem calling ${url}: ${error}`);
  }

  // if anything goes wrong, just respond with false, a not found.
  return false;
}

async function originRequest(
  request: EW.ResponseProviderRequest,
  body: Promise<String>,
  knowKey: Boolean
) {
  // first cleanup our request headers
  let requestHeaders = request.getHeaders();
  headersToRemove.forEach((element) => delete requestHeaders[element]);

  // add fraudster state
  requestHeaders["x-nomoreleaks-hit"] = [JSON.stringify(knowKey)];

  // fire off the request to our statically defined origin
  const url = "https://api.grinwis.com/headers";
  let originResponse = await httpRequest(url, {
    method: request.method,
    headers: requestHeaders,
    body: JSON.stringify(body),
  });

  return originResponse;
}
