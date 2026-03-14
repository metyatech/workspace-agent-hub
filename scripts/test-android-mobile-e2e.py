from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Iterable


SDK_ROOT = Path(os.environ.get("ANDROID_SDK_ROOT") or Path.home() / "AppData" / "Local" / "Android" / "Sdk")
ADB_EXE = SDK_ROOT / "platform-tools" / "adb.exe"
EMULATOR_EXE = SDK_ROOT / "emulator" / "emulator.exe"
AVDMANAGER_EXE = SDK_ROOT / "cmdline-tools" / "latest" / "bin" / "avdmanager.bat"

CONNECTBOT_PACKAGE = "org.connectbot"
CONNECTBOT_ACTIVITY = "org.connectbot/.ui.MainActivity"
CONNECTBOT_LATEST_RELEASE_API = "https://api.github.com/repos/connectbot/connectbot/releases/latest"
DEFAULT_AVD_NAME = "Medium_Phone_API_36.1"
TEMP_SSH_PORT = 2223
TEMP_SSH_USER = "mobilee2e"
TEMP_SSH_PASSWORD = "MobileE2E123"
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
MENU_SCRIPT_WSL = ""
E2E_SSHD_SCRIPT_WSL = ""
TMUX_ATTACHED_FLAG_PATH = "/tmp/workspace-agent-hub-mobile-e2e/tmux-attached.flag"


def run_command(args: list[str], *, check: bool = True, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=check, text=True, capture_output=True, timeout=timeout)


def adb_command(args: Iterable[str], *, check: bool = True, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return run_command([str(ADB_EXE), *args], check=check, timeout=timeout)


def adb_shell(command: str, *, check: bool = True, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return adb_command(["shell", command], check=check, timeout=timeout)


def wsl_root_bash(command: str, *, check: bool = True, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return run_command(["wsl.exe", "-d", "Ubuntu", "-u", "root", "--", "bash", "-lc", command], check=check, timeout=timeout)


def wsl_bash(command: str, *, check: bool = True, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return run_command(["wsl.exe", "-d", "Ubuntu", "--", "bash", "-lc", command], check=check, timeout=timeout)


def to_wsl_path(path: Path) -> str:
    normalized_path = str(path).replace("\\", "/")
    result = run_command(["wsl.exe", "-d", "Ubuntu", "--", "wslpath", "-a", "-u", normalized_path], check=True)
    return result.stdout.strip()


def sh_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def ensure_android_tools() -> None:
    missing = [path for path in (ADB_EXE, EMULATOR_EXE, AVDMANAGER_EXE) if not path.exists()]
    if missing:
        missing_text = ", ".join(str(path) for path in missing)
        raise RuntimeError(f"Android SDK tools are missing: {missing_text}")


def list_avds() -> list[str]:
    result = run_command([str(AVDMANAGER_EXE), "list", "avd"], check=True)
    names: list[str] = []
    for line in result.stdout.splitlines():
        match = re.search(r"^\s*Name:\s*(.+?)\s*$", line)
        if match:
            names.append(match.group(1))
    return names


def probe() -> int:
    try:
        ensure_android_tools()
        avds = list_avds()
        if not avds:
            raise RuntimeError("No Android virtual devices are configured.")
    except Exception as error:  # pragma: no cover - probe output only
        print(f"unavailable: {error}")
        return 1

    print("available")
    return 0


def get_emulator_serial() -> str | None:
    result = adb_command(["devices"], check=True)
    for line in result.stdout.splitlines():
        if line.startswith("emulator-") and "\tdevice" in line:
            return line.split("\t", 1)[0]
    return None


def ensure_emulator_running(avd_name: str) -> bool:
    if get_emulator_serial():
        return False

    subprocess.Popen(
        [
            str(EMULATOR_EXE),
            "-avd",
            avd_name,
            "-no-snapshot-load",
            "-no-boot-anim",
            "-noaudio",
            "-gpu",
            "swiftshader_indirect",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return True


def wait_for_boot(timeout_seconds: int = 180) -> str:
    deadline = time.time() + timeout_seconds
    last_serial = None
    while time.time() < deadline:
        last_serial = get_emulator_serial()
        if last_serial:
            boot = adb_shell("getprop sys.boot_completed", check=True).stdout.strip()
            if boot == "1":
                adb_command(["wait-for-device"], check=True, timeout=30)
                return last_serial
        time.sleep(2)
    raise RuntimeError(f"Android emulator did not finish booting. Last serial: {last_serial}")


def ensure_connectbot_installed(temp_dir: Path) -> None:
    package_check = adb_shell(f"pm path {CONNECTBOT_PACKAGE}", check=False)
    if package_check.returncode == 0 and package_check.stdout.strip():
        return

    release_response = urllib.request.urlopen(CONNECTBOT_LATEST_RELEASE_API, timeout=30)
    release_data = json.loads(release_response.read().decode("utf-8"))
    asset_url = ""
    for asset in release_data.get("assets", []):
        url = str(asset.get("browser_download_url") or "")
        name = str(asset.get("name") or "")
        if name.endswith("-oss.apk") and url:
            asset_url = url
            break
    if not asset_url:
        raise RuntimeError("Could not find a ConnectBot OSS APK in the latest GitHub release.")

    apk_path = temp_dir / "connectbot-oss.apk"
    with urllib.request.urlopen(asset_url, timeout=60) as response, apk_path.open("wb") as target:
        shutil.copyfileobj(response, target)

    adb_command(["install", "-r", str(apk_path)], check=True, timeout=180)


def dump_ui(temp_dir: Path, name: str) -> ET.Element:
    remote_path = f"/sdcard/{name}.xml"
    local_path = temp_dir / f"{name}.xml"
    adb_command(["shell", "uiautomator", "dump", remote_path], check=True, timeout=30)
    adb_command(["pull", remote_path, str(local_path)], check=True, timeout=30)
    return ET.parse(local_path).getroot()


def save_screenshot(temp_dir: Path, name: str) -> Path:
    screenshot_path = temp_dir / f"{name}.png"
    with screenshot_path.open("wb") as handle:
        process = subprocess.run([str(ADB_EXE), "exec-out", "screencap", "-p"], check=True, stdout=handle)
        if process.returncode != 0:
            raise RuntimeError(f"Failed to capture screenshot: {name}")
    return screenshot_path


def find_nodes(root: ET.Element, **attributes: str) -> list[ET.Element]:
    results: list[ET.Element] = []
    for node in root.iter("node"):
        if all(node.attrib.get(key) == value for key, value in attributes.items()):
            results.append(node)
    return results


def find_node_with_any_text(root: ET.Element, candidates: Iterable[str]) -> ET.Element | None:
    candidate_set = set(candidates)
    for node in root.iter("node"):
        if node.attrib.get("text") in candidate_set or node.attrib.get("content-desc") in candidate_set:
            return node
    return None


def find_clickable_action(root: ET.Element, label: str) -> ET.Element | None:
    for node in root.iter("node"):
        if node.attrib.get("clickable") != "true" or node.attrib.get("enabled") != "true":
            continue
        if node.attrib.get("text") == label or node.attrib.get("content-desc") == label:
            return node
        for child in node:
            if child.attrib.get("text") == label or child.attrib.get("content-desc") == label:
                return node
    return None


def parse_bounds(node: ET.Element) -> tuple[int, int]:
    bounds = node.attrib.get("bounds", "")
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not match:
        raise RuntimeError(f"Node is missing parseable bounds: {ET.tostring(node, encoding='unicode')}")
    left, top, right, bottom = (int(value) for value in match.groups())
    return ((left + right) // 2, (top + bottom) // 2)


def tap(x: int, y: int) -> None:
    adb_command(["shell", "input", "tap", str(x), str(y)], check=True, timeout=30)


def tap_node(node: ET.Element) -> None:
    x, y = parse_bounds(node)
    tap(x, y)


def tap_node_near_left(node: ET.Element, horizontal_offset: int = 160) -> None:
    bounds = node.attrib.get("bounds", "")
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not match:
        raise RuntimeError(f"Node is missing parseable bounds: {ET.tostring(node, encoding='unicode')}")
    left, top, right, bottom = (int(value) for value in match.groups())
    tap(min(left + horizontal_offset, right - 20), (top + bottom) // 2)


def wait_for_ui(
    temp_dir: Path,
    description: str,
    predicate,
    timeout_seconds: int = 30,
    screenshot_name: str | None = None,
) -> ET.Element:
    deadline = time.time() + timeout_seconds
    last_root: ET.Element | None = None
    while time.time() < deadline:
        last_root = dump_ui(temp_dir, f"ui-{description.replace(' ', '-')}")
        match = predicate(last_root)
        if match is not None:
            if screenshot_name:
                save_screenshot(temp_dir, screenshot_name)
            return last_root
        time.sleep(1)
    if screenshot_name:
        save_screenshot(temp_dir, f"{screenshot_name}-timeout")
    raise RuntimeError(f"Timed out waiting for UI state: {description}")


def maybe_tap_permission_allow(temp_dir: Path) -> None:
    root = dump_ui(temp_dir, "permission-check")
    allow_button = find_node_with_any_text(root, ["Allow"])
    if allow_button is not None:
        tap_node(allow_button)
        time.sleep(1)


def prepare_mobile_test_session(catalog_path: str) -> str:
    title = f"Android E2E Resume {uuid.uuid4().hex[:8]}"
    wsl_root_bash(
        f"install -d -m 700 -o {TEMP_SSH_USER} -g {TEMP_SSH_USER} /home/{TEMP_SSH_USER}",
        check=True,
        timeout=30,
    )
    result = run_command(
        [
            "wsl.exe",
            "-d",
            "Ubuntu",
            "-u",
            TEMP_SSH_USER,
            "--",
            "env",
            f"HOME=/home/{TEMP_SSH_USER}",
            f"AI_AGENT_SESSION_CATALOG_PATH={catalog_path}",
            "AI_AGENT_SESSION_NO_ATTACH=1",
            MENU_SCRIPT_WSL,
            "start",
            "shell",
            title,
        ],
        check=True,
        timeout=60,
    )
    match = re.search(r"Session ready:\s+([A-Za-z0-9._-]+)", result.stdout + result.stderr)
    if not match:
        raise RuntimeError(f"Could not parse prepared session name.\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}")
    return match.group(1)


def start_temp_sshd(catalog_path: str, session_name: str) -> None:
    run_command(
        [
            "wsl.exe",
            "-d",
            "Ubuntu",
            "-u",
            "root",
            "--",
            E2E_SSHD_SCRIPT_WSL,
            "start",
            "--port",
            str(TEMP_SSH_PORT),
            "--user",
            TEMP_SSH_USER,
            "--password",
            TEMP_SSH_PASSWORD,
            "--catalog-path",
            catalog_path,
            "--auto-resume-session",
            session_name,
        ],
        check=True,
        timeout=60,
    )


def stop_temp_sshd() -> None:
    run_command(
        [
            "wsl.exe",
            "-d",
            "Ubuntu",
            "-u",
            "root",
            "--",
            E2E_SSHD_SCRIPT_WSL,
            "stop",
            "--port",
            str(TEMP_SSH_PORT),
            "--purge-user",
        ],
        check=False,
        timeout=60,
    )


def kill_tmux_session(session_name: str) -> None:
    run_command(
        [
            "wsl.exe",
            "-d",
            "Ubuntu",
            "-u",
            TEMP_SSH_USER,
            "--",
            "tmux",
            "kill-session",
            "-t",
            session_name,
        ],
        check=False,
        timeout=30,
    )


def get_tmux_attached_count(session_name: str) -> int:
    result = run_command(
        [
            "wsl.exe",
            "-d",
            "Ubuntu",
            "-u",
            TEMP_SSH_USER,
            "--",
            "tmux",
            "display-message",
            "-p",
            "-t",
            session_name,
            "#{session_attached}",
        ],
        check=False,
        timeout=30,
    )
    try:
        return int(result.stdout.strip() or "0")
    except ValueError:
        return 0


def has_tmux_attach_flag() -> bool:
    result = wsl_root_bash(f"test -f {sh_quote(TMUX_ATTACHED_FLAG_PATH)} && printf yes || printf no", check=True, timeout=30)
    return result.stdout.strip() == "yes"


def get_sshd_log() -> str:
    result = wsl_root_bash("cat /tmp/workspace-agent-hub-mobile-e2e/sshd.log 2>/dev/null || true", check=True, timeout=30)
    return result.stdout


def get_login_hook_log() -> str:
    result = wsl_root_bash("cat /tmp/workspace-agent-hub-mobile-e2e/login-hook.log 2>/dev/null || true", check=True, timeout=30)
    return result.stdout


def launch_connectbot() -> None:
    adb_shell(f"pm clear {CONNECTBOT_PACKAGE}", check=True, timeout=60)
    adb_shell(f"am force-stop {CONNECTBOT_PACKAGE}", check=True, timeout=60)
    adb_shell(f"am start -n {CONNECTBOT_ACTIVITY}", check=True, timeout=60)
    time.sleep(2)


def input_text(text: str) -> None:
    adb_command(["shell", "input", "text", text], check=True, timeout=30)


def keyevent(key_code: int) -> None:
    adb_command(["shell", "input", "keyevent", str(key_code)], check=True, timeout=30)


def connect_with_connectbot(temp_dir: Path) -> None:
    launch_connectbot()

    root = wait_for_ui(
        temp_dir,
        "connectbot-home",
        lambda current: find_node_with_any_text(current, ["No hosts configured", "ConnectBot"]),
        timeout_seconds=30,
        screenshot_name="connectbot-home",
    )
    add_host_button = find_node_with_any_text(root, ["Add host"])
    if add_host_button is None:
        raise RuntimeError("Could not find the ConnectBot Add host button.")
    tap_node(add_host_button)

    root = wait_for_ui(
        temp_dir,
        "add-host",
        lambda current: find_node_with_any_text(current, ["Quick connect"]),
        timeout_seconds=30,
        screenshot_name="connectbot-add-host",
    )
    quick_connect_field = find_node_with_any_text(root, ["Quick connect"])
    if quick_connect_field is None:
        raise RuntimeError("Could not find the ConnectBot quick-connect field.")
    tap_node_near_left(quick_connect_field)
    wait_for_ui(
        temp_dir,
        "quick-connect-focused",
        lambda current: next(
            (
                node
                for node in current.iter("node")
                if node.attrib.get("class") == "android.widget.EditText" and node.attrib.get("focused") == "true"
            ),
            None,
        ),
        timeout_seconds=15,
    )
    connection_target = f"{TEMP_SSH_USER}@10.0.2.2:{TEMP_SSH_PORT}"
    input_text(connection_target)
    keyevent(4)

    root = wait_for_ui(
        temp_dir,
        "add-host-ready",
        lambda current: find_node_with_any_text(current, [connection_target]),
        timeout_seconds=15,
    )
    add_host_action = find_clickable_action(root, "Add host")
    if add_host_action is None:
        raise RuntimeError("Could not find the enabled Add host action in ConnectBot.")
    tap_node(add_host_action)

    root = wait_for_ui(
        temp_dir,
        "saved-host-row",
        lambda current: find_node_with_any_text(current, [f"{TEMP_SSH_USER}@10.0.2.2:{TEMP_SSH_PORT}"]),
        timeout_seconds=30,
        screenshot_name="connectbot-saved-host",
    )
    host_row = find_node_with_any_text(root, [f"{TEMP_SSH_USER}@10.0.2.2:{TEMP_SSH_PORT}"])
    if host_row is None:
        raise RuntimeError("Could not find the saved ConnectBot host row.")
    tap_node(host_row)
    deadline = time.time() + 60
    password_submitted = False
    while time.time() < deadline:
        log_text = get_sshd_log()
        if "Starting session:" in log_text:
            save_screenshot(temp_dir, "connectbot-authenticated")
            return

        root = dump_ui(temp_dir, "connectbot-auth-loop")
        allow_button = find_clickable_action(root, "Allow")
        if allow_button is not None:
            tap_node(allow_button)
            time.sleep(1)
            continue

        host_key_yes = find_clickable_action(root, "Yes")
        if host_key_yes is not None and find_node_with_any_text(root, ["Host key verification"]) is not None:
            tap_node(host_key_yes)
            time.sleep(1)
            continue

        password_label = find_node_with_any_text(root, ["Password: "])
        if password_label is not None and not password_submitted:
            tap_node_near_left(password_label)
            input_text(TEMP_SSH_PASSWORD)
            ok_button = find_clickable_action(root, "OK")
            if ok_button is None:
                root = dump_ui(temp_dir, "password-prompt-recheck")
                ok_button = find_clickable_action(root, "OK")
            if ok_button is None:
                raise RuntimeError("Could not find the ConnectBot password confirmation button.")
            tap_node(ok_button)
            password_submitted = True
            time.sleep(2)
            continue

        disconnect_dialog = find_node_with_any_text(root, ["Host has disconnected.\nClose session?"])
        if disconnect_dialog is not None:
            save_screenshot(temp_dir, "connectbot-disconnected-before-start")
            raise RuntimeError("ConnectBot disconnected before the server reported session start.")

        time.sleep(1)

    save_screenshot(temp_dir, "connectbot-auth-timeout")
    raise RuntimeError("Timed out waiting for ConnectBot to authenticate and start the mobile session.")


def wait_for_auto_attach(temp_dir: Path, session_name: str) -> None:
    deadline = time.time() + 30
    while time.time() < deadline:
        if has_tmux_attach_flag():
            save_screenshot(temp_dir, "connectbot-attached")
            return

        attached = get_tmux_attached_count(session_name)
        if attached >= 1:
            save_screenshot(temp_dir, "connectbot-attached")
            return

        log_text = get_sshd_log()
        if "Starting session:" in log_text and "Close session:" in log_text:
            save_screenshot(temp_dir, "connectbot-disconnected-after-start")
            raise RuntimeError(
                "ConnectBot authenticated, started the session, and then disconnected before tmux attach.\n"
                f"Login hook log:\n{get_login_hook_log()}"
            )

        root = dump_ui(temp_dir, "post-resume-check")
        disconnect_dialog = find_node_with_any_text(root, ["Host has disconnected.\nClose session?"])
        if disconnect_dialog is not None:
            save_screenshot(temp_dir, "connectbot-disconnected")
            raise RuntimeError("ConnectBot disconnected before the tmux session attached.")
        time.sleep(1)

    save_screenshot(temp_dir, "connectbot-attach-timeout")
    raise RuntimeError("The emulator did not attach to the prepared tmux session before the auto-attach timeout expired.")


def kill_emulator_if_started(started_here: bool) -> None:
    if not started_here:
        return
    adb_command(["emu", "kill"], check=False, timeout=30)


def main() -> int:
    if "--probe" in sys.argv[1:]:
        return probe()

    ensure_android_tools()
    global MENU_SCRIPT_WSL, E2E_SSHD_SCRIPT_WSL
    MENU_SCRIPT_WSL = to_wsl_path(SCRIPT_DIR / "wsl-agent-mobile-menu.sh")
    E2E_SSHD_SCRIPT_WSL = to_wsl_path(SCRIPT_DIR / "wsl-mobile-e2e-sshd.sh")
    avds = list_avds()
    avd_name = DEFAULT_AVD_NAME if DEFAULT_AVD_NAME in avds else avds[0]

    temp_dir = Path(tempfile.mkdtemp(prefix="workspace-agent-hub-android-mobile-e2e-"))
    started_emulator_here = False
    session_name = ""
    catalog_path = f"/home/{TEMP_SSH_USER}/.agent-handoff/session-catalog-{uuid.uuid4().hex}.json"
    try:
        started_emulator_here = ensure_emulator_running(avd_name)
        wait_for_boot()
        ensure_connectbot_installed(temp_dir)
        session_name = prepare_mobile_test_session(catalog_path)
        start_temp_sshd(catalog_path, session_name)
        connect_with_connectbot(temp_dir)
        wait_for_auto_attach(temp_dir, session_name)
        print("PASS")
        return 0
    finally:
        adb_shell(f"am force-stop {CONNECTBOT_PACKAGE}", check=False, timeout=30)
        if session_name:
            kill_tmux_session(session_name)
        stop_temp_sshd()
        kill_emulator_if_started(started_emulator_here)
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
