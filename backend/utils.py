import unicodedata
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# 지원 채널 폴더 목록
KNOWN_CHANNEL_FOLDERS = {"humanity", "sports", "animals", "tech", "rescene"}


def find_download_file(filename: str) -> Path | None:
    """
    macOS의 NFD/NFC 유니코드 정규화 차이 및 URL 디코딩 차이를 완벽히 해결하며,
    downloads 루트 및 하위 채널별 폴더(humanity, sports 등)까지 재귀 탐색하여 올바른 파일 경로를 반환합니다.
    """
    if not filename:
        return None

    # 슬래시 경로 정리
    clean_name = filename.strip("/\\")

    # 1. 파일 시스템 직접 검색 (상대 경로 포함: humanity/xxx.mp4 등)
    direct = DOWNLOAD_DIR / clean_name
    if direct.exists() and direct.is_file():
        return direct

    # 2. NFC / NFD 유니코드 정규화 비교 검색 (파일명 자체 또는 경로의 마지막 파일명)
    target_basename = Path(clean_name).name
    target_nfc = unicodedata.normalize("NFC", target_basename)
    target_nfd = unicodedata.normalize("NFD", target_basename)

    # 3. 루트 및 모든 하위 디렉토리(채널 폴더) 재귀 검색
    for item in DOWNLOAD_DIR.rglob("*"):
        if not item.is_file() or item.name.startswith("."):
            continue

        item_nfc = unicodedata.normalize("NFC", item.name)
        item_nfd = unicodedata.normalize("NFD", item.name)

        if item.name in (target_basename, target_nfc, target_nfd) or \
           item_nfc in (target_basename, target_nfc, target_nfd) or \
           item_nfd in (target_basename, target_nfc, target_nfd):
            return item

    return None


def detect_file_channel(file_path: Path) -> str | None:
    """
    파일 경로가 어떤 채널 폴더(humanity, sports 등)에 속해 있는지 감지합니다.
    """
    try:
        rel = file_path.resolve().relative_to(DOWNLOAD_DIR.resolve())
        parts = rel.parts
        if len(parts) > 1 and parts[0] in KNOWN_CHANNEL_FOLDERS:
            return parts[0]
    except Exception:
        pass
    return None
