// R2 presigned 다운로드 URL 생성
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const R2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME || 'kwmath-files';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const key = event.queryStringParameters?.key;
    if (!key) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'key 파라미터 필요' }) };
    }

    // 보안: reports/ 폴더는 phone4 검증 필요
    if (key.startsWith('reports/')) {
      const phone4 = event.queryStringParameters?.phone4;
      const keyPhone4 = key.split('/')[1];
      if (!phone4 || phone4 !== keyPhone4) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: '접근 권한 없음' }) };
      }
    }

    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
    });

    // 1시간 유효 다운로드 URL
    const downloadUrl = await getSignedUrl(R2, command, { expiresIn: 3600 });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ downloadUrl }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
