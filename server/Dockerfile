FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Cloud Run sets PORT env var; default 8000 for local testing.
ENV PORT=8000

CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT}
