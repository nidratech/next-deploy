import { CloudFront, S3 } from 'aws-sdk';

import parseInputOrigins from './parseInputOrigins';
import getDefaultCacheBehavior from './getDefaultCacheBehavior';
import createOriginAccessIdentity from './createOriginAccessIdentity';
import grantCloudFrontBucketAccess from './grantCloudFrontBucketAccess';
import { CloudFrontInputs, Origin } from '../../types';

export { default as createInvalidation } from './createInvalidation';

const servePrivateContentEnabled = (inputs: CloudFrontInputs) =>
  inputs?.origins?.some((origin: string | Origin) => origin && (origin as Origin).private === true);

const updateBucketsPolicies = async (
  s3: S3,
  origins: CloudFront.Origins,
  s3CanonicalUserId: string
) => {
  // update bucket policies with cloudfront access
  const bucketNames = origins.Items.filter((origin) => origin.S3OriginConfig).map(
    (origin) => origin.Id
  );

  return Promise.all(
    bucketNames.map((bucketName: string) =>
      grantCloudFrontBucketAccess(s3, bucketName, s3CanonicalUserId)
    )
  );
};

export const createCloudFrontDistribution = async (
  cf: CloudFront,
  s3: S3,
  inputs: CloudFrontInputs
) => {
  let originAccessIdentityId;
  let s3CanonicalUserId;

  if (servePrivateContentEnabled(inputs)) {
    ({ originAccessIdentityId, s3CanonicalUserId } = await createOriginAccessIdentity(cf));
  }

  const { Origins, CacheBehaviors } = parseInputOrigins(inputs.origins, {
    originAccessIdentityId,
  });

  if (s3CanonicalUserId) {
    await updateBucketsPolicies(s3, Origins, s3CanonicalUserId);
  }

  const createDistributionRequest: CloudFront.Types.CreateDistributionRequest = {
    DistributionConfig: {
      CallerReference: String(Date.now()),
      Comment: inputs.comment as string,
      Aliases: {
        Quantity: 0,
        Items: [],
      },
      Origins,
      PriceClass: 'PriceClass_All',
      Enabled: inputs.enabled as boolean,
      HttpVersion: 'http2',
      DefaultCacheBehavior: getDefaultCacheBehavior(Origins.Items[0].Id, inputs.defaults),
    },
  };

  if (CacheBehaviors) {
    createDistributionRequest.DistributionConfig.CacheBehaviors = CacheBehaviors;
  }

  const res = await cf.createDistribution(createDistributionRequest).promise();

  return {
    id: res?.Distribution?.Id,
    arn: res?.Distribution?.ARN,
    url: `https://${res?.Distribution?.DomainName}`,
  };
};

export const updateCloudFrontDistribution = async (
  cf: CloudFront,
  s3: S3,
  distributionId: string,
  inputs: CloudFrontInputs
) => {
  const distributionConfigResponse = await cf
    .getDistributionConfig({ Id: distributionId })
    .promise();

  if (!distributionConfigResponse.DistributionConfig) {
    throw new Error('Could not get a distribution config');
  }

  let s3CanonicalUserId;
  let originAccessIdentityId;

  if (servePrivateContentEnabled(inputs)) {
    // presumably it's ok to call create origin access identity again
    // aws api returns cached copy of what was previously created
    // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/CloudFront.html#createCloudFrontOriginAccessIdentity-property
    ({ originAccessIdentityId, s3CanonicalUserId } = await createOriginAccessIdentity(cf));
  }

  const { Origins, CacheBehaviors } = parseInputOrigins(inputs.origins, {
    originAccessIdentityId,
  });

  if (s3CanonicalUserId) {
    await updateBucketsPolicies(s3, Origins, s3CanonicalUserId);
  }

  const updateDistributionRequest: CloudFront.Types.UpdateDistributionRequest = {
    Id: distributionId,
    IfMatch: distributionConfigResponse.ETag,
    DistributionConfig: {
      CallerReference: distributionConfigResponse.DistributionConfig.CallerReference,
      Enabled: inputs.enabled as boolean,
      Comment: inputs.comment as string,
      DefaultCacheBehavior: getDefaultCacheBehavior(Origins.Items[0].Id, inputs.defaults),
      Origins,
    },
  };

  if (CacheBehaviors) {
    updateDistributionRequest.DistributionConfig.CacheBehaviors = CacheBehaviors;
  }

  const res = await cf.updateDistribution(updateDistributionRequest).promise();

  return {
    id: res?.Distribution?.Id,
    arn: res?.Distribution?.ARN,
    url: `https://${res?.Distribution?.DomainName}`,
  };
};

const disableCloudFrontDistribution = async (cf: CloudFront, distributionId: string) => {
  const distributionConfigResponse = await cf
    .getDistributionConfig({ Id: distributionId })
    .promise();

  if (!distributionConfigResponse.DistributionConfig) {
    throw new Error('Could not get a distribution config');
  }

  const updateDistributionRequest: CloudFront.Types.UpdateDistributionRequest = {
    Id: distributionId,
    IfMatch: distributionConfigResponse.ETag,
    DistributionConfig: {
      CallerReference: distributionConfigResponse.DistributionConfig.CallerReference,
      Enabled: false,
      Comment: distributionConfigResponse.DistributionConfig.Comment,
      DefaultCacheBehavior: distributionConfigResponse.DistributionConfig.DefaultCacheBehavior,
      Origins: distributionConfigResponse.DistributionConfig.Origins,
    },
  };

  const res = await cf.updateDistribution(updateDistributionRequest).promise();

  return {
    id: res?.Distribution?.Id,
    arn: res?.Distribution?.ARN,
    url: `https://${res?.Distribution?.DomainName}`,
  };
};

export const deleteCloudFrontDistribution = async (cf: CloudFront, distributionId: string) => {
  try {
    const res = await cf.getDistributionConfig({ Id: distributionId }).promise();

    const params = { Id: distributionId, IfMatch: res.ETag };
    await cf.deleteDistribution(params).promise();
  } catch (e) {
    if (e.code === 'DistributionNotDisabled') {
      await disableCloudFrontDistribution(cf, distributionId);
    } else {
      throw e;
    }
  }
};