/**
 * 原始文件 content-type 映射（管理端 /documents/:id/file 与用户侧
 * /api/research/evidence/:id/file 共用；PDF/HTML 浏览器原生渲染，其余如实标注）。
 */
const CT_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export function contentTypeForFileName(fileName: string): string {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  return CT_BY_EXT[ext] ?? 'application/octet-stream'
}
