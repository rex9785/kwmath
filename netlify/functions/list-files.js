// R2 파일 목록 조회
const { S3Client, ListObjectsV2Command, HeadObjectCommand } = require('@aws-sdk/client-s3');

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
    // folder 파라미터: 'materials'(자료실) 또는 'reports/{phone4}'(리포트)
    const folder = event.queryStringParameters?.folder || 'materials';

    const command = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: folder + '/',
      MaxKeys: 200,
    });

    const data = await R2.send(command);
    const files = (data.Contents || []).map((obj) => {
      // 키에서 파일명 추출 (타임스탬프_파일명 → 파일명)
      const keyParts = obj.Key.split('/');
      const rawName = keyParts[keyParts.length - 1];
      const displayName = rawName.replace(/^\d+_/, ''); // 타임스탬프 제거

      return {
        key: obj.Key,
        name: displayName,
        size: obj.Size,
        lastModified: obj.LastModified,
      };
    }).filter(f => f.name); // 빈 폴더 항목 제거

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(files),
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
