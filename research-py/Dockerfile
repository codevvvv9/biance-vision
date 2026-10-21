FROM python:3.12-slim

WORKDIR /app

# WITH_DOCLING=1 时构建含 PDF/DOCX 解析的全量镜像（docling+torch，构建数分钟）；
# 默认 0：轻量镜像，解析层懒加载，PDF 显式 failed 状态（TXT/MD/HTML 不受影响）
ARG WITH_DOCLING=0

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MODEL_DIR=/data/models

COPY requirements.txt requirements-docling.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$WITH_DOCLING" = "1" ]; then pip install --no-cache-dir -r requirements-docling.txt; fi

# W1-B 模型预置（rag-pipeline §2.2）：构建期把 Docling 模型下载进镜像
# （DOCLING_ARTIFACTS_PATH 指向预置目录），运行期零下载——本地/线上首次解析不再
# 卡在 HF Hub 慢速下载（2026-10-21 实测本地完整解析被 HF 运行时下载阻塞的根因）。
# 预热方式：import + 一次最小 convert 触发 layout/tableformer 模型落盘。
RUN if [ "$WITH_DOCLING" = "1" ]; then \
      DOCLING_ARTIFACTS_PATH=/opt/docling-models \
      python -c "\
from docling.datamodel.base_models import DocumentStream
from docling.document_converter import DocumentConverter
import io
DocumentConverter().convert(DocumentStream(name='warm.pdf', stream=io.BytesIO(b'')))\
" || (echo 'docling warmup failed' && exit 1); \
    fi
ENV DOCLING_ARTIFACTS_PATH=/opt/docling-models

COPY app ./app

EXPOSE 8100

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
