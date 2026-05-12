// R2 presigned 업로드 URL 생성 (관리자 전용)
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
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
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { password, fileName, fileType, folder } = body;

    // 관리자 인증
    if (password !== ADMIN_PASSWORD) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: '인증 실패' }) };
    }

    if (!fileName || !fileType) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: '파일명과 타입이 필요합니다' }) };
    }

    // 파일 키 생성: 폴더/타임스탬프_파일명
    const timestamp = Date.now();
    const safeFileName = fileName.replace(/[^a-zA-Z0-9가-힣.\-_]/g, '_');
    const key = folder ? `${folder}/${timestamp}_${safeFileName}` : `materials/${timestamp}_${safeFileName}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: fileType,
    });

    // 10분 유효 presigned URL
    const uploadUrl = await getSignedUrl(R2, command, { expiresIn: 600 });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ uploadUrl, key }),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
