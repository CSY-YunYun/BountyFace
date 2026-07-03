from fastapi import FastAPI

app = FastAPI(title="BountyFace Backend")

@app.get("/health")
def health_check():
    return {"status": "ok"}
