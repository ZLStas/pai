// Copyright (c) Microsoft Corporation
// All rights reserved.
//
// MIT License
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
// BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// module dependencies
const _ = require('lodash');
const axios = require('axios');
const {Client} = require('@elastic/elasticsearch');
const base32 = require('base32');
const {Agent} = require('https');

const {convertToJobAttempt} = require('@pai/utils/frameworkConverter');
const launcherConfig = require('@pai/config/launcher');
const {apiserver} = require('@pai/config/kubernetes');
const createError = require('@pai/utils/error');

let elasticSearchClient;
if (!_.isNil(process.env.ELASTICSEARCH_URI)) {
  elasticSearchClient = new Client({node: process.env.ELASTICSEARCH_URI});
}

const convertName = (name) => {
  // convert framework name to fit framework controller spec
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
};

const encodeName = (name) => {
  if (name.startsWith('unknown') || !name.includes('~')) {
    // framework is not generated by PAI
    return convertName(name.replace(/^unknown/g, ''));
  } else {
    // base32 encode
    return base32.encode(name);
  }
};

// job attempts api only works in k8s launcher and when elastic search exists
const healthCheck = async () => {
  const launcherType = process.env.LAUNCHER_TYPE;
  if (launcherType === 'yarn') {
    return false;
  } else if (_.isNil(elasticSearchClient)) {
    return false;
  } else {
    try {
      const result = await elasticSearchClient.indices.get({
        index: 'framework',
      });
      if (result.statusCode === 200) {
        return true;
      } else {
        return false;
      }
    } catch (e) {
      return false;
    }
  }
};

// list job attempts
const list = async (frameworkName) => {
  let attemptData = [];

  // get latest framework from k8s API
  let response;
  try {
    response = await axios({
      method: 'get',
      url: launcherConfig.frameworkPath(encodeName(frameworkName)),
      headers: launcherConfig.requestHeaders,
      httpsAgent: apiserver.ca && new Agent({ca: apiserver.ca}),
    });
  } catch (error) {
    if (error.response != null) {
      response = error.response;
    } else {
      throw error;
    }
  }

  if (response.status === 200) {
    attemptData.push({...await convertToJobAttempt(response.data), isLatest: true});
  } else if (response.status === 404) {
    return {status: 404, data: null};
  } else {
    throw createError(response.status, 'UnknownError', response.data.message);
  }

  if (!healthCheck) {
    return {status: 501, data: null};
  }

  // get history frameworks from elastic search
  const body = {
    query: {
      bool: {
        filter: {
          term: {
            'objectSnapshot.metadata.name.keyword': encodeName(frameworkName),
          },
        },
      },
    },
    size: 0,
    aggs: {
      attemptID_group: {
        terms: {
          field: 'objectSnapshot.status.attemptStatus.id',
          order: {
            _key: 'desc',
          },
        },
        aggs: {
          collectTime_latest_hits: {
            top_hits: {
              sort: [
                {
                  collectTime: {
                    order: 'desc',
                  },
                },
              ],
              size: 1,
            },
          },
        },
      },
    },
  };

  const esResult = await elasticSearchClient.search({
    index: 'framework',
    body: body,
  });

  const buckets = esResult.body.aggregations.attemptID_group.buckets;

  if (_.isEmpty(buckets)) {
    return {status: 404, data: null};
  } else {
    const retryFrameworks = buckets.map((bucket) => {
      return bucket.collectTime_latest_hits.hits.hits[0]._source.objectSnapshot;
    });
    const jobRetries = await Promise.all(
      retryFrameworks.map((attemptFramework) => {
        return convertToJobAttempt(attemptFramework);
      }),
    );
    attemptData.push(
      ...jobRetries.map((jobRetry) => {
        return {...jobRetry, isLatest: false};
      }),
    );

    return {status: 200, data: attemptData};
  }
};

const get = async (frameworkName, jobAttemptIndex) => {
  if (!healthCheck) {
    return {status: 501, data: null};
  }

  let attemptFramework;
  let response;
  try {
    response = await axios({
      method: 'get',
      url: launcherConfig.frameworkPath(encodeName(frameworkName)),
      headers: launcherConfig.requestHeaders,
      httpsAgent: apiserver.ca && new Agent({ca: apiserver.ca}),
    });
  } catch (error) {
    if (error.response != null) {
      response = error.response;
    } else {
      throw error;
    }
  }

  if (response.status === 200) {
    attemptFramework = response.data;
  } else if (response.status === 404) {
    return {status: 404, data: null};
  } else {
    throw createError(response.status, 'UnknownError', response.data.message);
  }

  if (jobAttemptIndex < attemptFramework.spec.retryPolicy.maxRetryCount) {
    // get history frameworks from elastic search
    const body = {
      query: {
        bool: {
          filter: {
            term: {
              'objectSnapshot.metadata.name.keyword': encodeName(frameworkName),
            },
          },
        },
      },
      size: 0,
      aggs: {
        attemptID_group: {
          filter: {
            term: {
              'objectSnapshot.status.attemptStatus.id': jobAttemptIndex,
            },
          },
          aggs: {
            collectTime_latest_hits: {
              top_hits: {
                sort: [
                  {
                    collectTime: {
                      order: 'desc',
                    },
                  },
                ],
                size: 1,
              },
            },
          },
        },
      },
    };

    const esResult = await elasticSearchClient.search({
      index: 'framework',
      body: body,
    });

    const buckets =
      esResult.body.aggregations.attemptID_group.collectTime_latest_hits.hits
        .hits;

    if (_.isEmpty(buckets)) {
      return {status: 404, data: null};
    } else {
      attemptFramework = buckets[0]._source.objectSnapshot;
      const attemptDetail = await convertToJobAttempt(attemptFramework);
      return {status: 200, data: {...attemptDetail, isLatest: false}};
    }
  } else if (
    jobAttemptIndex === attemptFramework.spec.retryPolicy.maxRetryCount
  ) {
    // get latest frameworks from k8s API
    const attemptDetail = await convertToJobAttempt(attemptFramework);
    return {status: 200, data: {...attemptDetail, isLatest: true}};
  } else {
    return {status: 404, data: null};
  }
};

module.exports = {
  healthCheck,
  list,
  get,
};
