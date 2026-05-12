export const getEmbedUrl = (originalUrl) => {
  if (!originalUrl) return "";
  let url = originalUrl;

  // Google Drive
  if (url.includes('drive.google.com')) {
    return url.replace('/view?pli=1', '/preview').replace('/view', '/preview');
  }

  // SharePoint & OneDrive
  if (url.includes('sharepoint.com') || url.includes('onedrive.com') || url.includes('1drv.ms')) {
    if (url.includes('view.aspx')) {
      url = url.replace('view.aspx', 'embed.aspx');
    }
    
    if (!url.includes('action=embedview')) {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}action=embedview`;
    }
    return url;
  }

  return url;
};
