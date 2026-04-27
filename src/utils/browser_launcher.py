# -*- coding: utf-8 -*-
"""
浏览器启动器模块

用于检测和启动用户安装的 Chrome/Edge 浏览器，支持 Windows/macOS/Linux。
"""
import os
import platform
import subprocess
import time
import socket
import signal
from typing import Optional, List, Tuple
import asyncio
from pathlib import Path

from src.utils import utils


class BrowserLauncher:
    """
    浏览器启动器

    负责检测系统中安装的浏览器并启动 CDP 调试连接。
    """

    def __init__(self):
        self.system = platform.system()
        self.browser_process = None
        self.debug_port = None

    def detect_browser_paths(self) -> List[str]:
        """
        检测系统中可用的浏览器路径

        Returns:
            List[str]: 按优先级排序的浏览器路径列表
        """
        paths = []

        if self.system == "Windows":
            # Common Chrome/Edge installation paths on Windows
            possible_paths = [
                # Chrome paths
                os.path.expandvars(r"%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"),
                os.path.expandvars(r"%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"),
                os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
                # Edge paths
                os.path.expandvars(r"%PROGRAMFILES%\Microsoft\Edge\Application\msedge.exe"),
                os.path.expandvars(r"%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe"),
                # Chrome Beta/Dev/Canary
                os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome Beta\Application\chrome.exe"),
                os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome Dev\Application\chrome.exe"),
                os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome SxS\Application\chrome.exe"),
            ]
        elif self.system == "Darwin":  # macOS
            # Common Chrome/Edge installation paths on macOS
            possible_paths = [
                # Chrome paths
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
                "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
                "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
                # Edge paths
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
                "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
                "/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
            ]
        else:
            # Linux and other systems
            possible_paths = [
                "/usr/bin/google-chrome",
                "/usr/bin/google-chrome-stable",
                "/usr/bin/google-chrome-beta",
                "/usr/bin/google-chrome-unstable",
                "/usr/bin/chromium-browser",
                "/usr/bin/chromium",
                "/snap/bin/chromium",
                "/usr/bin/microsoft-edge",
                "/usr/bin/microsoft-edge-stable",
                "/usr/bin/microsoft-edge-beta",
                "/usr/bin/microsoft-edge-dev",
            ]

        # Check if path exists and is executable
        for path in possible_paths:
            if os.path.isfile(path) and os.access(path, os.X_OK):
                paths.append(path)

        return paths

    def find_available_port(self, start_port: int = 9222) -> int:
        """
        查找可用端口

        Args:
            start_port: 起始端口号

        Returns:
            int: 可用端口号

        Raises:
            RuntimeError: 找不到可用端口
        """
        port = start_port
        while port < start_port + 100:  # 最多尝试 100 个端口
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.bind(("localhost", port))
                    return port
            except OSError:
                port += 1

        raise RuntimeError(f"无法找到可用端口，已尝试 {start_port} 到 {port-1}")

    def launch_browser(
        self,
        browser_path: str,
        debug_port: int,
        headless: bool = False,
        user_data_dir: Optional[str] = None,
    ) -> subprocess.Popen:
        """
        启动浏览器进程

        Args:
            browser_path: 浏览器可执行文件路径
            debug_port: CDP 调试端口
            headless: 是否无头模式
            user_data_dir: 用户数据目录

        Returns:
            subprocess.Popen: 浏览器进程对象
        """
        # 基本启动参数
        args = [
            browser_path,
            f"--remote-debugging-port={debug_port}",
            "--remote-debugging-address=0.0.0.0",  # 允许远程访问
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-features=TranslateUI",
            "--disable-ipc-flooding-protection",
            "--disable-hang-monitor",
            "--disable-prompt-on-repost",
            "--disable-sync",
            "--disable-dev-shm-usage",  # 避免共享内存问题
            "--no-sandbox",  # CDP 模式下禁用沙箱
            # 关键反检测参数
            "--disable-blink-features=AutomationControlled",  # 禁用自动化控制标志
            "--exclude-switches=enable-automation",  # 排除自动化开关
            "--disable-infobars",  # 禁用信息栏
        ]

        # 无头模式
        if headless:
            args.extend(
                [
                    "--headless=new",  # 使用新版无头模式
                    "--disable-gpu",
                ]
            )
        else:
            # 非无头模式的额外参数
            args.extend(
                [
                    "--start-maximized",  # 最大化窗口，更像真实用户
                ]
            )

        # 用户数据目录
        if user_data_dir:
            args.append(f"--user-data-dir={user_data_dir}")

        utils.logger.info(f"[BrowserLauncher] 正在启动浏览器: {browser_path}")
        utils.logger.info(f"[BrowserLauncher] 调试端口: {debug_port}")
        utils.logger.info(f"[BrowserLauncher] 无头模式: {headless}")

        try:
            # Windows 下使用 CREATE_NEW_PROCESS_GROUP 防止 Ctrl+C 影响子进程
            if self.system == "Windows":
                process = subprocess.Popen(
                    args,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
                )
            else:
                process = subprocess.Popen(
                    args,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    preexec_fn=os.setsid,  # 创建新进程组
                )

            self.browser_process = process
            return process

        except Exception as e:
            utils.logger.error(f"[BrowserLauncher] 启动浏览器失败: {e}")
            raise

    def wait_for_browser_ready(self, debug_port: int, timeout: int = 30) -> bool:
        """
        等待浏览器就绪

        Args:
            debug_port: CDP 调试端口
            timeout: 超时时间（秒）

        Returns:
            bool: 是否成功就绪
        """
        utils.logger.info(f"[BrowserLauncher] 正在等待浏览器在端口 {debug_port} 就绪...")

        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                    s.settimeout(1)
                    result = s.connect_ex(("localhost", debug_port))
                    if result == 0:
                        utils.logger.info(
                            f"[BrowserLauncher] 浏览器已在端口 {debug_port} 就绪"
                        )
                        return True
            except Exception:
                pass

            time.sleep(0.5)

        utils.logger.error(
            f"[BrowserLauncher] 浏览器在 {timeout} 秒内未能就绪"
        )
        return False

    def get_browser_info(self, browser_path: str) -> Tuple[str, str]:
        """
        获取浏览器信息（名称和版本）

        Args:
            browser_path: 浏览器路径

        Returns:
            Tuple[str, str]: (浏览器名称, 版本号)
        """
        try:
            if "chrome" in browser_path.lower():
                name = "Google Chrome"
            elif "edge" in browser_path.lower() or "msedge" in browser_path.lower():
                name = "Microsoft Edge"
            elif "chromium" in browser_path.lower():
                name = "Chromium"
            else:
                name = "Unknown Browser"

            # Try to get version info
            try:
                result = subprocess.run([browser_path, "--version"],
                                      capture_output=True, text=True, timeout=5)
                version = result.stdout.strip() if result.stdout else "未知版本"
            except:
                version = "未知版本"

            return name, version

        except Exception:
            return "未知浏览器", "未知版本"

    def cleanup(self):
        """清理资源，关闭浏览器进程"""
        if not self.browser_process:
            return

        process = self.browser_process

        if process.poll() is not None:
            utils.logger.info(
                "[BrowserLauncher] 浏览器进程已退出，无需清理"
            )
            self.browser_process = None
            return

        utils.logger.info("[BrowserLauncher] 正在关闭浏览器进程...")

        try:
            if self.system == "Windows":
                # 先尝试正常终止
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    utils.logger.warning(
                        "[BrowserLauncher] 正常终止超时，使用 taskkill 强制终止"
                    )
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                        capture_output=True,
                        check=False,
                    )
                    process.wait(timeout=5)
            else:
                pgid = os.getpgid(process.pid)
                try:
                    os.killpg(pgid, signal.SIGTERM)
                except ProcessLookupError:
                    utils.logger.info(
                        "[BrowserLauncher] 浏览器进程组不存在，可能已退出"
                    )
                else:
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        utils.logger.warning(
                            "[BrowserLauncher] 优雅关闭超时，发送 SIGKILL"
                        )
                        os.killpg(pgid, signal.SIGKILL)
                        process.wait(timeout=5)

            utils.logger.info("[BrowserLauncher] 浏览器进程已关闭")
        except Exception as e:
            utils.logger.warning(f"[BrowserLauncher] 关闭浏览器进程时出错: {e}")
        finally:
            self.browser_process = None
