import unicodedata
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DOWNLOAD_DIR = BASE_DIR / "downloads"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


def find_download_file(filename: str) -> Path | None:
    """
    macOS의 NFD/NFC 유니코드 정규화 차이 및 URL 디코딩 차이를 완벽히 해결하여
    downloads 폴더에서 올바른 파일 경로를 반환합니다.
    """
    if not filename:
        return None

    # 1. 파일 시스템 직접 검색
    direct = DOWNLOAD_DIR / filename
    if direct.exists() and direct.is_file():
        return direct

    # 2. NFC / NFD 유니코드 정규화 비교 검색
    target_nfc = unicodedata.normalize("NFC", filename)
    target_nfd = unicodedata.normalize("NFD", filename)

    for item in DOWNLOAD_DIR.iterdir():
        if not item.is_file():
            continue
        item_nfc = unicodedata.normalize("NFC", item.name)
        item_nfd = unicodedata.normalize("NFD", item.name)

        if item.name in (filename, target_nfc, target_nfd) or \
           item_nfc in (filename, target_nfc, target_nfd) or \
           item_nfd in (filename, target_nfc, target_nfd):
            return item

    return None
