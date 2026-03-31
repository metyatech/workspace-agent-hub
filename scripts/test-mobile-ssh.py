from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from getpass import getuser
from pathlib import Path


WINDOWS_OPENSSH_DIR = r"C:\Windows\System32\OpenSSH"
SCRIPT_DIR = Path(__file__).resolve().parent
LAUNCHER_SCRIPT = SCRIPT_DIR / "agent-session-launcher.ps1"
REPO_ROOT = SCRIPT_DIR.parent
WORKSPACE_ROOT = REPO_ROOT.parent
POWERSHELL_EXE = shutil.which("pwsh.exe") or shutil.which("pwsh") or shutil.which("powershell.exe") or shutil.which("powershell")


def resolve_windows_openssh_binary(binary_name: str, *fallback_names: str) -> str | None:
    candidate = os.path.join(WINDOWS_OPENSSH_DIR, binary_name)
    if os.path.exists(candidate):
        return candidate

    for fallback_name in fallback_names:
        resolved = shutil.which(fallback_name)
        if resolved:
            return resolved

    return None


SSH_EXE = resolve_windows_openssh_binary("ssh.exe", "ssh.exe", "ssh")
SSH_KEYGEN_EXE = resolve_windows_openssh_binary("ssh-keygen.exe", "ssh-keygen.exe", "ssh-keygen")
SSHD_EXE = resolve_windows_openssh_binary("sshd.exe")
ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")


def resolve_windows_ssh_test_user() -> str:
    candidates = (
        os.environ.get("WORKSPACE_AGENT_HUB_TEST_SSH_USER"),
        os.environ.get("USERNAME"),
        os.environ.get("USER"),
        getuser(),
    )
    for candidate in candidates:
        if candidate:
            return candidate.split("\\")[-1]
    raise RuntimeError("Unable to resolve the Windows SSH test user.")


SSH_TEST_USER = resolve_windows_ssh_test_user()


def to_openssh_path(path: str | Path) -> str:
    return str(path).replace("\\", "/")


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE_RE.sub("", text)


def run_command(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=check,
        text=True,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )


def powershell_file(script_path: Path, *script_args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    if not POWERSHELL_EXE:
        raise RuntimeError("PowerShell executable not found.")
    return run_command(
        [
            POWERSHELL_EXE,
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script_path),
            *script_args,
        ],
        check=check,
    )


def launcher_create_shell(label: str, title: str, working_directory: str) -> str:
    session_name = f"shell-{label}"
    powershell_file(
        LAUNCHER_SCRIPT,
        "-Mode",
        "new",
        "-Type",
        "shell",
        "-Name",
        label,
        "-Title",
        title,
        "-WorkingDirectory",
        working_directory,
        "-Detach",
    )
    return session_name


def launcher_delete_session(session_name: str) -> None:
    powershell_file(
        LAUNCHER_SCRIPT,
        "-Mode",
        "delete",
        "-SessionName",
        session_name,
        check=False,
    )


def launcher_list_sessions(*, include_archived: bool = False) -> list[dict[str, object]]:
    args = ["-Mode", "list", "-Json"]
    if include_archived:
        args.append("-IncludeArchived")
    result = powershell_file(LAUNCHER_SCRIPT, *args)
    raw = result.stdout.strip()
    if not raw:
        return []
    parsed = json.loads(raw)
    return parsed if isinstance(parsed, list) else [parsed]


def launcher_get_session(session_name: str, *, include_archived: bool = False) -> dict[str, object] | None:
    for item in launcher_list_sessions(include_archived=include_archived):
        if str(item.get("Name", "")) == session_name:
            return item
    return None


def launcher_assert_resume_available(session_name: str) -> None:
    result = powershell_file(
        LAUNCHER_SCRIPT,
        "-Mode",
        "resume",
        "-SessionName",
        session_name,
        "-Detach",
    )
    expected = f"Session '{session_name}' is available"
    if expected not in result.stdout:
        raise RuntimeError(f"Unexpected launcher resume output for {session_name!r}: {result.stdout.strip()}")


def wsl_bash(command: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run_command(["wsl.exe", "-d", "Ubuntu", "--", "bash", "-lc", command], check=check)


def to_wsl_path(path: Path) -> str:
    normalized_path = str(path).replace("\\", "/")
    result = run_command(["wsl.exe", "-d", "Ubuntu", "--", "wslpath", "-a", "-u", normalized_path])
    return result.stdout.strip()


def tmux_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return int(sock.getsockname()[1])


def create_keypair(path: Path) -> None:
    if not SSH_KEYGEN_EXE:
        raise RuntimeError("ssh-keygen.exe not found.")
    run_command([SSH_KEYGEN_EXE, "-q", "-t", "ed25519", "-N", "", "-f", str(path)])


class InteractiveSsh:
    def __init__(self, port: int, key_path: Path, known_hosts_path: Path) -> None:
        if not SSH_EXE:
            raise RuntimeError("ssh.exe not found.")

        self.process = subprocess.Popen(
            [
                SSH_EXE,
                "-tt",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                f"UserKnownHostsFile={known_hosts_path}",
                "-i",
                str(key_path),
                "-p",
                str(port),
                f"{SSH_TEST_USER}@127.0.0.1",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self._stdout_chunks: list[str] = []
        self._stderr_chunks: list[str] = []
        self._lock = threading.Lock()
        self._stdout_thread = threading.Thread(target=self._reader, args=(self.process.stdout, self._stdout_chunks), daemon=True)
        self._stderr_thread = threading.Thread(target=self._reader, args=(self.process.stderr, self._stderr_chunks), daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()

    def _reader(self, stream, chunks: list[str]) -> None:
        try:
            while True:
                data = stream.read(1)
                if not data:
                    break
                with self._lock:
                    chunks.append(data.decode("utf-8", errors="ignore"))
        finally:
            try:
                stream.close()
            except OSError:
                pass

    def output(self) -> str:
        with self._lock:
            return "".join(self._stdout_chunks) + "".join(self._stderr_chunks)

    def stdout_output(self) -> str:
        with self._lock:
            return "".join(self._stdout_chunks)

    def checkpoint(self) -> int:
        return len(self.stdout_output())

    def wait_for(self, needle: str, timeout_seconds: float, *, after: int = 0) -> str:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            stdout_text = self.stdout_output()
            if needle in stdout_text[after:]:
                return stdout_text
            if self.process.poll() is not None:
                time.sleep(0.2)
                raise RuntimeError(f"SSH process exited before '{needle}' appeared.\nOutput:\n{self.output()}")
            time.sleep(0.05)
        raise RuntimeError(f"Timed out waiting for '{needle}'.\nOutput tail:\n{self.output()[-4000:]}")

    def send(self, text: str) -> None:
        if not self.process.stdin:
            raise RuntimeError("SSH stdin is unavailable.")
        self.process.stdin.write(text.encode("utf-8"))
        self.process.stdin.flush()

    def close(self) -> str:
        if self.process.stdin:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        self.process.wait(timeout=20)
        self._stdout_thread.join(timeout=2)
        self._stderr_thread.join(timeout=2)
        return self.output()


class TemporarySshd:
    def __init__(self) -> None:
        self.temp_dir = Path(tempfile.mkdtemp(prefix="workspace-agent-hub-mobile-sshd-"))
        self.port = find_free_port()
        self.user_key_path = self.temp_dir / "client_ed25519"
        self.host_key_path = self.temp_dir / "host_ed25519"
        self.authorized_keys_path = self.temp_dir / "authorized_keys"
        self.known_hosts_path = self.temp_dir / "known_hosts"
        self.config_path = self.temp_dir / "sshd_config"
        self.process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        if not SSHD_EXE:
            raise RuntimeError("Windows sshd.exe not found.")
        create_keypair(self.user_key_path)
        create_keypair(self.host_key_path)

        public_key = self.user_key_path.with_suffix(".pub").read_text(encoding="utf-8").strip()
        self.authorized_keys_path.write_text(public_key + "\n", encoding="utf-8")
        bootstrap_script_wsl = to_wsl_path(SCRIPT_DIR / "wsl-mobile-login-bootstrap.sh")
        force_command = f"wsl.exe -d Ubuntu -- bash -lc {tmux_quote(bootstrap_script_wsl)}"

        config = "\n".join(
            [
                f"Port {self.port}",
                "ListenAddress 127.0.0.1",
                f"PidFile {to_openssh_path(self.temp_dir / 'sshd.pid')}",
                f"AuthorizedKeysFile {to_openssh_path(self.authorized_keys_path)}",
                f"HostKey {to_openssh_path(self.host_key_path)}",
                "PubkeyAuthentication yes",
                "PasswordAuthentication no",
                "KbdInteractiveAuthentication no",
                "StrictModes no",
                "LogLevel VERBOSE",
                "Subsystem sftp sftp-server.exe",
                f"ForceCommand {force_command}",
                "",
            ]
        )
        self.config_path.write_text(config, encoding="utf-8")

        run_command([SSHD_EXE, "-t", "-f", str(self.config_path)])
        self.process = subprocess.Popen(
            [SSHD_EXE, "-D", "-e", "-f", str(self.config_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
        )
        self._wait_until_listening()

    def _wait_until_listening(self) -> None:
        deadline = time.time() + 15
        while time.time() < deadline:
            if self.process and self.process.poll() is not None:
                stderr = self.process.stderr.read().decode("utf-8", errors="ignore") if self.process.stderr else ""
                stdout = self.process.stdout.read().decode("utf-8", errors="ignore") if self.process.stdout else ""
                raise RuntimeError(f"Temporary sshd exited early.\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}")
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(0.2)
                if sock.connect_ex(("127.0.0.1", self.port)) == 0:
                    return
            time.sleep(0.1)
        raise RuntimeError(f"Temporary sshd did not start listening on port {self.port}.")

    def stop(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        shutil.rmtree(self.temp_dir, ignore_errors=True)


def ensure_tmux_session(session_name: str, working_directory: str) -> None:
    wsl_bash(
        f"tmux kill-session -t {tmux_quote(session_name)} >/dev/null 2>&1 || true; "
        f"tmux new-session -d -s {tmux_quote(session_name)} -c {tmux_quote(working_directory)}"
    )


def kill_tmux_session(session_name: str) -> None:
    wsl_bash(f"tmux kill-session -t {tmux_quote(session_name)} >/dev/null 2>&1 || true", check=False)


def parse_session_index(output: str, title: str, folder: str | None = None) -> str:
    lines = output.splitlines()
    for line in lines:
        plain_line = strip_ansi(line)
        if title not in plain_line:
            continue
        if folder and f"folder={folder}" not in plain_line:
            continue
        match = re.search(r"\[(\d+)\]", plain_line)
        if match:
            return match.group(1)
    raise RuntimeError(f"Unable to find a session index for title={title!r} folder={folder!r}.\nOutput:\n{output}")


def disconnect_ssh(ssh: InteractiveSsh) -> str:
    if ssh.process.poll() is None:
        ssh.process.terminate()
        try:
            ssh.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            ssh.process.kill()
            ssh.process.wait(timeout=5)
    return ssh.close()


def assert_pc_to_mobile_resume_flow(sshd: TemporarySshd, cleanup_sessions: set[str]) -> None:
    suffix = uuid.uuid4().hex[:10]
    session_label = f"matrix-pc-mobile-{suffix}"
    session_name = launcher_create_shell(session_label, f"Matrix PC Mobile {suffix}", str(WORKSPACE_ROOT))
    cleanup_sessions.add(session_name)

    ssh = InteractiveSsh(sshd.port, sshd.user_key_path, sshd.known_hosts_path)
    try:
        ssh.wait_for("AI session mobile menu", 15)
        after = ssh.checkpoint()
        ssh.send("2\n")
        output = ssh.wait_for(f"Matrix PC Mobile {suffix}", 15, after=after)
        selected_index = parse_session_index(output, f"Matrix PC Mobile {suffix}", str(WORKSPACE_ROOT))
        after = ssh.checkpoint()
        ssh.send(f"{selected_index}\n")
        ssh.wait_for(to_wsl_path(WORKSPACE_ROOT), 15, after=after)
        disconnect_ssh(ssh)
    finally:
        if ssh.process.poll() is None:
            disconnect_ssh(ssh)


def assert_mobile_start_pc_resume_flow(sshd: TemporarySshd, cleanup_sessions: set[str]) -> None:
    suffix = uuid.uuid4().hex[:10]
    session_title = f"Matrix Mobile Start {suffix}"

    ssh = InteractiveSsh(sshd.port, sshd.user_key_path, sshd.known_hosts_path)
    try:
        ssh.wait_for("AI session mobile menu", 15)

        after = ssh.checkpoint()
        ssh.send("1\n")
        ssh.wait_for("Type (codex/claude/gemini/shell):", 15, after=after)

        after = ssh.checkpoint()
        ssh.send("shell\n")
        ssh.wait_for("What is this session about? (optional):", 15, after=after)

        after = ssh.checkpoint()
        ssh.send(f"{session_title}\n")
        ssh.wait_for("Working directory (optional, default:", 15, after=after)

        after = ssh.checkpoint()
        ssh.send(f"{to_wsl_path(REPO_ROOT)}\n")
        ssh.wait_for(to_wsl_path(REPO_ROOT), 15, after=after)

        disconnect_ssh(ssh)
    finally:
        if ssh.process.poll() is None:
            disconnect_ssh(ssh)

    launcher_session = None
    for item in launcher_list_sessions():
        if str(item.get("DisplayTitle", "")) == session_title:
            launcher_session = item
            break
    if not launcher_session:
        raise RuntimeError("Expected PC launcher inventory to include the mobile-started session title.")

    session_name = str(launcher_session.get("Name", ""))
    if not session_name:
        raise RuntimeError("Expected the launcher inventory to expose the mobile-started session name.")
    cleanup_sessions.add(session_name)

    if str(launcher_session.get("DisplayTitle", "")) != session_title:
        raise RuntimeError(
            f"Expected launcher title {session_title!r} for mobile-started session, got {str(launcher_session.get('DisplayTitle', ''))!r}."
        )

    if str(launcher_session.get("WorkingDirectoryWindows", "")) != str(REPO_ROOT):
        raise RuntimeError(
            f"Expected launcher inventory to report {REPO_ROOT} for the mobile-started session."
        )

    if not bool(launcher_session.get("IsLive", False)):
        raise RuntimeError("Expected the mobile-started session to remain live in the PC launcher inventory.")

    launcher_assert_resume_available(session_name)


def assert_multi_session_selection_flow(sshd: TemporarySshd, cleanup_sessions: set[str]) -> None:
    suffix = uuid.uuid4().hex[:10]
    session_a = launcher_create_shell(f"matrix-pick-a-{suffix}", f"Matrix Pick A {suffix}", str(WORKSPACE_ROOT))
    session_b = launcher_create_shell(f"matrix-pick-b-{suffix}", f"Matrix Pick B {suffix}", str(REPO_ROOT))
    cleanup_sessions.update({session_a, session_b})

    ssh = InteractiveSsh(sshd.port, sshd.user_key_path, sshd.known_hosts_path)
    try:
        ssh.wait_for("AI session mobile menu", 15)
        after = ssh.checkpoint()
        ssh.send("2\n")
        output = ssh.wait_for(f"Matrix Pick B {suffix}", 15, after=after)
        if f"Matrix Pick A {suffix}" not in output:
            output = ssh.wait_for(f"Matrix Pick A {suffix}", 15, after=after)
        selected_index = parse_session_index(output, f"Matrix Pick B {suffix}", str(REPO_ROOT))
        after = ssh.checkpoint()
        ssh.send(f"{selected_index}\n")
        ssh.wait_for(to_wsl_path(REPO_ROOT), 15, after=after)
        disconnect_ssh(ssh)
    finally:
        if ssh.process.poll() is None:
            disconnect_ssh(ssh)


def main() -> None:
    cleanup_sessions: set[str] = set()
    sshd = TemporarySshd()
    try:
        sshd.start()
        assert_pc_to_mobile_resume_flow(sshd, cleanup_sessions)
        assert_mobile_start_pc_resume_flow(sshd, cleanup_sessions)
        assert_multi_session_selection_flow(sshd, cleanup_sessions)
        print("PASS")
    finally:
        for session_name in cleanup_sessions:
            launcher_delete_session(session_name)
            kill_tmux_session(session_name)
        sshd.stop()


if __name__ == "__main__":
    main()
