FROM python:3.12-slim

WORKDIR /app

# WITH_DOCLING=1 时构建含 PDF/DOCX 解析的全量镜像（docling+torch，构建数分钟）；
# 默认 0：轻量镜像，解析层懒加载，PDF 显式 failed 状态（TXT/MD/HTML 不受影响）
ARG WITH_DOCLING=0

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MODEL_DIR=/data/models

COPY requirements.txt requirements-docling.txt warmup.py ./
# R2：rapidocr-onnxruntime（OpenCV）需要 X11/GLib 系统库（python:slim 不含）；
# 仅 WITH_DOCLING=1 时安装（轻量镜像不需要）
RUN if [ "$WITH_DOCLING" = "1" ]; then \
      apt-get update -qq && apt-get install -y -qq --no-install-recommends \
        libxcb1 libgl1 libglib2.0-0 libgomp1 \
      && rm -rf /var/lib/apt/lists/*; fi
# W1-B 模型预置：warmup 转换最小 PDF 触发 layout/tableformer 模型下载进镜像的
# 默认 HF cache（~/.cache/huggingface/hub）。运行期不设 DOCLING_ARTIFACTS_PATH
# ——该变量期望 docling 特有的扁平 artifacts 目录结构，HF cache 不匹配会导致
# 运行时校验失败（v0.10.2 教训）；不设时 docling 自动从 HF cache 找到 warmup
# 已下载的模型，运行期零网络下载
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$WITH_DOCLING" = "1" ]; then pip install --no-cache-dir -r requirements-docling.txt && python warmup.py; fi

COPY app ./app

EXPOSE 8100

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
