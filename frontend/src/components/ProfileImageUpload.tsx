import React, { useState } from 'react';
import { Button, Upload, message, Avatar } from 'antd';
import { UploadOutlined, UserOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import type { RcFile, UploadChangeParam, UploadFile } from 'antd/es/upload/interface';

interface ProfileImageUploadProps {
  userId: number;
  currentImageUrl?: string | null;
  onImageUpdate?: (newImageUrl: string) => void;
}

// แนะนำให้เก็บ base URL ใน .env
// VITE_API_BASE_URL=https://ememo.hylifeconnect.com
const API = import.meta.env.VITE_API_BASE_URL ?? '';

const ProfileImageUpload: React.FC<ProfileImageUploadProps> = ({
  userId,
  currentImageUrl,
  onImageUpdate,
}) => {
  const [loading, setLoading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(currentImageUrl || null);

  const uploadProps: UploadProps = {
    name: 'profileImage',
    action: `${API}/api/users/${userId}/profile-image`,
    withCredentials: true, // ✅ ส่งคุกกี้ข้ามโดเมน
    showUploadList: false,

    // ใส่ไทป์ให้ param ชัด (แต่จริง ๆ ถ้าติดตั้ง antd แล้ว TS จะอนุมานได้)
    beforeUpload: (file: RcFile) => {
      const isImage = file.type?.startsWith('image/');
      if (!isImage) {
        message.error('You can only upload image files!');
        return Upload.LIST_IGNORE;
      }
      const isLt5M = file.size / 1024 / 1024 < 5;
      if (!isLt5M) {
        message.error('Image must smaller than 5MB!');
        return Upload.LIST_IGNORE;
      }
      return true;
    },

    onChange: (info: UploadChangeParam<UploadFile<{ profileImageUrl?: string }>>) => {
      if (info.file.status === 'uploading') {
        setLoading(true);
        return;
      }
      if (info.file.status === 'done') {
        setLoading(false);
        const res = info.file.response as { profileImageUrl?: string };
        if (res?.profileImageUrl) {
          setImageUrl(res.profileImageUrl);
          onImageUpdate?.(res.profileImageUrl);
          message.success('Profile image uploaded successfully!');
        } else {
          message.warning('Uploaded but no image URL returned.');
        }
      }
      if (info.file.status === 'error') {
        setLoading(false);
        message.error('Upload failed!');
      }
    },
  };

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ marginBottom: 16 }}>
        <Avatar
          size={100}
          src={imageUrl ?? undefined}
          icon={!imageUrl ? <UserOutlined /> : undefined}
          style={{ marginBottom: 8 }}
        />
      </div>
      <Upload {...uploadProps}>
        <Button icon={<UploadOutlined />} loading={loading} type="primary">
          {loading ? 'Uploading...' : 'Upload Profile Image'}
        </Button>
      </Upload>
    </div>
  );
};

export default ProfileImageUpload;
