export type FileCard = {
  filename: string;
  fileId: string;
  contentType: string;
  summary: string;
  time: string;
};

export type TimelineItem = {
  pageId: string;
  from: string;
  to: string;
  summary: string;
};

export type ChannelFilePreview = {
  file_id: string;
  original_filename?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
};
