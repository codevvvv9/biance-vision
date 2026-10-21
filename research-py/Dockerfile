FROM python:3.12-slim

WORKDIR /app

# WITH_DOCLING=1 时构建含 PDF/DOCX 解析的全量镜像（docling+torch，构建数分钟）；
# 默认 0：轻量镜像，解析层懒加载，PDF 显式 failed 状态（TXT/MD/HTML 不受影响）
ARG WITH_DOCLING=0

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MODEL_DIR=/data/models

COPY requirements.txt requirements-docling.txt warmup.py ./
# W1-B 模型预置：warmup 期间不设 DOCLING_ARTIFACTS_PATH（docling 对空目录直接校验
# 失败——v0.10.0 教训），模型落默认缓存 /root/.cache/docling；warmup 成功后再把
# 运行期变量指向该缓存（运行期零 HF 下载）
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$WITH_DOCLING" = "1" ]; then pip install --no-cache-dir -r requirements-docling.txt && python warmup.py; fi
RUN if [ "$WITH_DOCLING" = "1" ]; then export DOCLING_ARTIFACTS_PATH=/root/.cache/docling; fi
ENV DOCLING_ARTIFACTS_PATH=/root/.cache/docling

COPY app ./app

EXPOSE 8100

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
