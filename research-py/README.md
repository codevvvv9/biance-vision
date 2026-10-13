# research-py

固定任务 HTTP 服务（Python + FastAPI + uvicorn），负责文档解析与统计模型训练/推理。
**不提供任意代码执行入口**，仅暴露以下固定端点：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 存活探针：`{status, docling, sklearnVersion}` |
| POST | `/tasks/parse-document` | Docling 解析 PDF/DOCX（TXT/MD/HTML 由 Node 原生解析，不入此口） |
| POST | `/tasks/train` | 分位数 GBM 训练（每分位一个模型），产出校准报告与 joblib 工件 |
| POST | `/tasks/predict` | 加载工件推理，输出分位数与 `probabilityUp` |
| POST | `/tasks/calibration-report` | 由预测与结果计算 Brier / 可靠性桶 / 分位覆盖率 |

时间纪律：本服务不做任何时间切分决策，dev/calibration/test 的 `split` 全部由调用方（Node worker）给定。

## 本地运行

需要 Python 3.12（Docker 镜像为 `python:3.12-slim`）。较低版本（≥3.9）可运行除 docling 外的全部功能；docling 要求 Python ≥3.10，缺失时 `/tasks/parse-document` 返回 `status=failed` 而不影响其他端点。

```bash
cd research-py
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8100
```

使用 uv（可选）：

```bash
cd research-py
uv venv && uv pip install -r requirements.txt
uv run uvicorn app.main:app --host 0.0.0.0 --port 8100
```

冒烟自检（不需要先启动服务，进程内跑全部端点）：

```bash
.venv/bin/python -m app.test_smoke
```

## Docker

```bash
docker build -t research-py research-py/
docker run --rm -p 8100:8100 -v research-py-models:/data/models research-py
```

注意：`docker build` 中安装 docling 依赖较重（含 torch），首次构建可能需要数分钟。

## 配置

- `MODEL_DIR`：模型工件（joblib）目录，默认 `./data/models`（Docker 中为 `/data/models`）；也可在请求体中用 `artifactDir` 覆盖。
- 除 `/tasks/parse-document` 的 `fetchUrl` 抓取（10MB 上限、20s 超时）外，本服务无网络出站；无子进程；无 eval/exec。
