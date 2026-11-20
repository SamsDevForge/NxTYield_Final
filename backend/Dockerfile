FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY backend /app/backend
RUN useradd --create-home farmsense && mkdir /data && chown farmsense:farmsense /data
ENV FARMSENSE_DATABASE_PATH=/data/farmsense.sqlite3
USER farmsense
EXPOSE 8000
CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
