from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def hello() -> dict[str, str]:
    return {"message": "Hello from the Python sample"}


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
