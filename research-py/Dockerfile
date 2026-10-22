FROM python:3.12-slim

WORKDIR /app

# WITH_DOCLING=1：构建含 Docling+MinerU 双引擎的全量镜像（数分钟）；
# 默认 0：轻量镜像，解析层懒加载，PDF 显式 failed 状态（TXT/MD/HTML 不受影响）
# WITH_MINERU=1：追加 MinerU（magic-pdf）——与 Docling 共存，双引擎按需路由
ARG WITH_DOCLING=0
ARG WITH_MINERU=0

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MODEL_DIR=/data/models

COPY requirements.txt requirements-docling.txt warmup.py warmup_mineru.py ./

# 系统依赖：docling+rapidocr（OpenCV）和 MinerU（PyMuPDF）都需要的基础库
# libxcb1/libgl1 = OpenCV X11；libglib2.0 = GLib；libgomp1 = OpenMP
# libmagic1 = python-magic（MinerU 依赖）；git = MinerU 模型下载
RUN if [ "$WITH_DOCLING" = "1" ] || [ "$WITH_MINERU" = "1" ]; then \
      apt-get update -qq && apt-get install -y -qq --no-install-recommends \
        libxcb1 libgl1 libglib2.0-0 libgomp1 libmagic1 git \
      && rm -rf /var/lib/apt/lists/*; fi

# Python 依赖 + 双引擎模型预置（构建期触发模型下载进镜像，运行期零网络下载）
# Docling warmup：转换最小 PDF → layout/tableformer 模型进 HF cache
# MinerU warmup：magic-pdf CLI 解析最小 PDF → 布局/OCR/表格模型进本地 cache
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$WITH_DOCLING" = "1" ]; then \
         pip install --no-cache-dir -r requirements-docling.txt && python warmup.py; \
       fi \
    && if [ "$WITH_MINERU" = "1" ]; then \
         pip install --no-cache-dir "magic-pdf[full]" 2>/dev/null || \
         pip install --no-cache-dir magic-pdf; \
         python warmup_mineru.py; \
       fi

COPY app ./app

EXPOSE 8100

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
