FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY pyproject.toml README.md ./
RUN pip install .
COPY transcriber.py ./

RUN useradd --create-home --uid 10001 cheers
USER cheers

CMD ["python", "transcriber.py", "start"]
