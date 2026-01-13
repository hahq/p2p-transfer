/**
 * P2P传输工具 - 基于WebRTC的点对点文件和文本传输
 * 使用PeerJS简化WebRTC连接
 */

// ===== 配置 =====
const CONFIG = {
    CHUNK_SIZE: 64 * 1024,  // 文件分块大小：64KB
    ROOM_CODE_LENGTH: 6,     // 房间码长度
    HEARTBEAT_INTERVAL: 5000, // 心跳间隔：5秒
    HEARTBEAT_TIMEOUT: 15000, // 心跳超时：15秒
    TRANSFER_TIMEOUT: 30000,  // 传输超时：30秒无进度
    PEERJS_CONFIG: {
        // 使用PeerJS公共服务器
        // 如果连接不稳定，可以考虑自建服务器
    }
};

// ===== 全局状态 =====
let peer = null;           // PeerJS实例
let connection = null;     // 当前连接
let currentRoomCode = '';  // 当前房间码
let isHost = false;        // 是否是房间创建者
let pendingFiles = [];     // 待发送文件队列
let receivingFiles = {};   // 正在接收的文件 {fileId: {meta, chunks, receivedSize, lastUpdate}}

// 心跳和连接保活
let heartbeatTimer = null;      // 心跳定时器
let lastHeartbeat = 0;          // 最后收到心跳的时间
let heartbeatCheckTimer = null; // 心跳检查定时器
let transferCheckTimer = null;  // 传输超时检查定时器

// 已完成文件列表 {fileId: {name, size, url, downloaded}}
let completedFiles = {};

// ===== DOM 元素 =====
const elements = {
    // 主题
    themeToggle: document.getElementById('themeToggle'),

    // 连接状态
    connectionStatus: document.getElementById('connectionStatus'),

    // 连接界面
    connectionSection: document.getElementById('connectionSection'),
    createRoomBtn: document.getElementById('createRoomBtn'),
    roomCodeDisplay: document.getElementById('roomCodeDisplay'),
    roomCodeValue: document.getElementById('roomCodeValue'),
    copyRoomCodeBtn: document.getElementById('copyRoomCodeBtn'),
    joinCodeInput: document.getElementById('joinCodeInput'),
    joinRoomBtn: document.getElementById('joinRoomBtn'),

    // 传输界面
    transferSection: document.getElementById('transferSection'),
    currentRoomCode: document.getElementById('currentRoomCode'),
    disconnectBtn: document.getElementById('disconnectBtn'),

    // 文件传输
    fileDropZone: document.getElementById('fileDropZone'),
    fileInput: document.getElementById('fileInput'),
    sendingFiles: document.getElementById('sendingFiles'),
    sendingFilesList: document.getElementById('sendingFilesList'),
    receivedFiles: document.getElementById('receivedFiles'),
    receivedFilesList: document.getElementById('receivedFilesList'),

    // 文本传输
    textInput: document.getElementById('textInput'),
    sendTextBtn: document.getElementById('sendTextBtn'),
    receivedTexts: document.getElementById('receivedTexts'),
    textMessages: document.getElementById('textMessages'),

    // 选项卡
    tabBtns: document.querySelectorAll('.tab-btn'),
    createTab: document.getElementById('createTab'),
    joinTab: document.getElementById('joinTab'),

    // Toast
    toast: document.getElementById('toast'),

    // 二维码
    showQRCodeBtn: document.getElementById('showQRCodeBtn'),
    qrcodeContainer: document.getElementById('qrcodeContainer'),
    qrcodeCanvas: document.getElementById('qrcodeCanvas')
};

// ===== 初始化 =====
function init() {
    initTheme();
    initEventListeners();
    checkUrlParams(); // 检查URL参数是否有房间码
}

// ===== 主题管理 =====
function initTheme() {
    const savedTheme = localStorage.getItem('p2p-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (savedTheme) {
        document.documentElement.setAttribute('data-theme', savedTheme);
    } else if (prefersDark) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('p2p-theme', newTheme);
}

// ===== 事件监听 =====
function initEventListeners() {
    // 主题切换
    elements.themeToggle.addEventListener('click', toggleTheme);

    // 选项卡切换
    elements.tabBtns.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // 创建房间
    elements.createRoomBtn.addEventListener('click', createRoom);

    // 复制房间码
    elements.copyRoomCodeBtn.addEventListener('click', copyRoomCode);

    // 加入房间
    elements.joinRoomBtn.addEventListener('click', joinRoom);
    elements.joinCodeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') joinRoom();
    });

    // 断开连接
    elements.disconnectBtn.addEventListener('click', disconnect);

    // 文件选择和拖放
    elements.fileDropZone.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', handleFileSelect);

    elements.fileDropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        elements.fileDropZone.classList.add('dragover');
    });

    elements.fileDropZone.addEventListener('dragleave', () => {
        elements.fileDropZone.classList.remove('dragover');
    });

    elements.fileDropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.fileDropZone.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
    });

    // 发送文本
    elements.sendTextBtn.addEventListener('click', sendText);
    elements.textInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) sendText();
    });

    // 显示二维码
    elements.showQRCodeBtn.addEventListener('click', toggleQRCode);
}

// ===== 选项卡切换 =====
function switchTab(tabName) {
    elements.tabBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    elements.createTab.classList.toggle('active', tabName === 'create');
    elements.joinTab.classList.toggle('active', tabName === 'join');
}

// ===== 房间管理 =====

// 生成随机房间码
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from(
        { length: CONFIG.ROOM_CODE_LENGTH },
        () => chars[Math.floor(Math.random() * chars.length)]
    ).join('');
}

// 创建房间
async function createRoom() {
    currentRoomCode = generateRoomCode();
    isHost = true;

    updateConnectionStatus('connecting');
    elements.createRoomBtn.disabled = true;

    try {
        // 使用房间码作为Peer ID
        peer = new Peer(currentRoomCode, CONFIG.PEERJS_CONFIG);

        peer.on('open', (id) => {
            console.log('房间创建成功，ID:', id);
            elements.roomCodeValue.textContent = currentRoomCode;
            elements.roomCodeDisplay.classList.remove('hidden');
        });

        peer.on('connection', (conn) => {
            console.log('有用户连接');
            connection = conn;
            setupConnection();
        });

        peer.on('error', (err) => {
            console.error('Peer错误:', err);
            handlePeerError(err);
        });

    } catch (error) {
        console.error('创建房间失败:', error);
        showToast('创建房间失败，请重试', 'error');
        resetConnection();
    }
}

// ===== 二维码功能 =====

let qrcodeInstance = null; // 保存二维码实例

// 生成二维码
function generateQRCode() {
    const joinUrl = getJoinUrl(currentRoomCode);
    const container = elements.qrcodeCanvas;

    // 清空之前的二维码
    container.innerHTML = '';

    // 使用 qrcodejs 的 API
    qrcodeInstance = new QRCode(container, {
        text: joinUrl,
        width: 180,
        height: 180,
        colorDark: '#1e293b',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
    });
}

// 获取加入房间的URL
function getJoinUrl(roomCode) {
    const baseUrl = window.location.origin + window.location.pathname;
    return `${baseUrl}?room=${roomCode}`;
}

// 切换显示二维码
function toggleQRCode() {
    const container = elements.qrcodeContainer;
    const btn = elements.showQRCodeBtn;

    if (container.classList.contains('hidden')) {
        generateQRCode();
        container.classList.remove('hidden');
        btn.innerHTML = '🔼 隐藏二维码';
    } else {
        container.classList.add('hidden');
        btn.innerHTML = '📱 显示二维码';
    }
}

// 检查URL参数自动加入房间
function checkUrlParams() {
    const urlParams = new URLSearchParams(window.location.search);
    const roomCode = urlParams.get('room');

    if (roomCode && roomCode.length === CONFIG.ROOM_CODE_LENGTH) {
        // 清除URL参数，避免刷新后重复加入
        window.history.replaceState({}, document.title, window.location.pathname);

        // 自动填入房间码并切换到加入选项卡
        elements.joinCodeInput.value = roomCode.toUpperCase();
        switchTab('join');

        // 延迟一点自动加入，让用户看到界面
        setTimeout(() => {
            showToast('正在自动加入房间...', 'success');
            joinRoom();
        }, 500);
    }
}

// 加入房间
async function joinRoom() {
    const code = elements.joinCodeInput.value.trim().toUpperCase();

    if (code.length !== CONFIG.ROOM_CODE_LENGTH) {
        showToast('请输入正确的6位房间码', 'error');
        return;
    }

    currentRoomCode = code;
    isHost = false;

    updateConnectionStatus('connecting');
    elements.joinRoomBtn.disabled = true;

    try {
        // 创建自己的Peer
        peer = new Peer(CONFIG.PEERJS_CONFIG);

        peer.on('open', () => {
            console.log('正在连接到房间:', code);
            // 连接到目标房间
            connection = peer.connect(code, {
                reliable: true
            });
            setupConnection();
        });

        peer.on('error', (err) => {
            console.error('Peer错误:', err);
            handlePeerError(err);
        });

    } catch (error) {
        console.error('加入房间失败:', error);
        showToast('加入房间失败，请重试', 'error');
        resetConnection();
    }
}

// 设置连接
function setupConnection() {
    if (!connection) return;

    connection.on('open', () => {
        console.log('连接已建立');
        updateConnectionStatus('connected');
        showTransferSection();
        showToast('连接成功！', 'success');

        // 启动心跳保活
        startHeartbeat();
    });

    connection.on('data', handleData);

    connection.on('close', () => {
        console.log('连接已关闭');
        showToast('对方已断开连接', 'error');
        resetConnection();
    });

    connection.on('error', (err) => {
        console.error('连接错误:', err);
        showToast('连接出现错误', 'error');
    });
}

// ===== 心跳保活机制 =====

// 启动心跳
function startHeartbeat() {
    lastHeartbeat = Date.now();

    // 清除旧的定时器
    stopHeartbeat();

    // 定期发送心跳
    heartbeatTimer = setInterval(() => {
        if (connection && connection.open) {
            try {
                connection.send({ type: 'heartbeat', timestamp: Date.now() });
            } catch (e) {
                console.error('发送心跳失败:', e);
            }
        }
    }, CONFIG.HEARTBEAT_INTERVAL);

    // 检查心跳超时
    heartbeatCheckTimer = setInterval(() => {
        if (Date.now() - lastHeartbeat > CONFIG.HEARTBEAT_TIMEOUT) {
            console.warn('心跳超时，连接可能已断开');
            // 检查连接状态
            if (connection && !connection.open) {
                showToast('连接已断开', 'error');
                resetConnection();
            }
        }
    }, CONFIG.HEARTBEAT_INTERVAL);

    // 检查传输超时
    transferCheckTimer = setInterval(checkTransferTimeout, 5000);
}

// 停止心跳
function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (heartbeatCheckTimer) {
        clearInterval(heartbeatCheckTimer);
        heartbeatCheckTimer = null;
    }
    if (transferCheckTimer) {
        clearInterval(transferCheckTimer);
        transferCheckTimer = null;
    }
}

// 检查传输超时
function checkTransferTimeout() {
    const now = Date.now();

    for (const fileId in receivingFiles) {
        const file = receivingFiles[fileId];
        if (file.lastUpdate && now - file.lastUpdate > CONFIG.TRANSFER_TIMEOUT) {
            console.warn('文件传输超时:', file.meta.name);

            // 更新UI显示超时
            const el = document.getElementById(`file-${fileId}`);
            if (el) {
                const statusEl = el.querySelector('.file-status');
                if (statusEl) {
                    statusEl.className = 'file-status error';
                    statusEl.textContent = '传输超时';
                }
            }

            showToast(`文件 "${file.meta.name}" 传输超时`, 'error');

            // 清理超时的文件
            delete receivingFiles[fileId];
        }
    }
}

// 处理页面可见性变化（手机后台处理）
function handleVisibilityChange() {
    if (document.hidden) {
        console.log('页面进入后台');
    } else {
        console.log('页面回到前台');

        // 检查连接状态
        if (connection) {
            if (connection.open) {
                // 连接仍然活跃，发送心跳确认
                try {
                    connection.send({ type: 'heartbeat', timestamp: Date.now() });
                    console.log('连接仍然活跃');
                } catch (e) {
                    console.error('连接已失效:', e);
                    showToast('连接已断开，请重新连接', 'error');
                    resetConnection();
                }
            } else {
                // 连接已关闭
                showToast('连接已断开，请重新连接', 'error');
                resetConnection();
            }
        }
    }
}

// 初始化页面可见性监听
document.addEventListener('visibilitychange', handleVisibilityChange);

// 处理Peer错误
function handlePeerError(err) {
    let message = '连接错误';

    switch (err.type) {
        case 'peer-unavailable':
            message = '房间不存在或已关闭';
            break;
        case 'network':
            message = '网络错误，请检查网络连接';
            break;
        case 'server-error':
            message = '信令服务器错误，请稍后重试';
            break;
        case 'unavailable-id':
            message = '该房间码已被使用，请重新创建';
            break;
        default:
            message = `连接错误: ${err.message}`;
    }

    showToast(message, 'error');
    resetConnection();
}

// 断开连接
function disconnect() {
    if (connection) {
        connection.close();
    }
    if (peer) {
        peer.destroy();
    }
    resetConnection();
    showToast('已断开连接');
}

// 重置连接状态
function resetConnection() {
    peer = null;
    connection = null;
    currentRoomCode = '';
    isHost = false;
    pendingFiles = [];
    receivingFiles = {};

    updateConnectionStatus('disconnected');

    // 重置UI
    elements.connectionSection.classList.remove('hidden');
    elements.transferSection.classList.add('hidden');
    elements.roomCodeDisplay.classList.add('hidden');
    elements.createRoomBtn.disabled = false;
    elements.joinRoomBtn.disabled = false;
    elements.joinCodeInput.value = '';

    // 清空文件列表
    elements.sendingFilesList.innerHTML = '';
    elements.receivedFilesList.innerHTML = '';
    elements.textMessages.innerHTML = '';
    elements.sendingFiles.classList.add('hidden');
    elements.receivedFiles.classList.add('hidden');
    elements.receivedTexts.classList.add('hidden');

    // 重置二维码
    elements.qrcodeContainer.classList.add('hidden');
    elements.showQRCodeBtn.innerHTML = '📱 显示二维码';

    // 停止心跳
    stopHeartbeat();
}

// 显示传输界面
function showTransferSection() {
    elements.connectionSection.classList.add('hidden');
    elements.transferSection.classList.remove('hidden');
    elements.currentRoomCode.textContent = currentRoomCode;
}

// 更新连接状态
function updateConnectionStatus(status) {
    const statusEl = elements.connectionStatus;
    statusEl.className = 'status-badge';

    switch (status) {
        case 'disconnected':
            statusEl.classList.add('status-disconnected');
            statusEl.innerHTML = '<span class="status-dot"></span>未连接';
            break;
        case 'connecting':
            statusEl.classList.add('status-connecting');
            statusEl.innerHTML = '<span class="status-dot"></span>连接中...';
            break;
        case 'connected':
            statusEl.classList.add('status-connected');
            statusEl.innerHTML = '<span class="status-dot"></span>已连接';
            break;
    }
}

// ===== 数据处理 =====
function handleData(data) {
    // 更新心跳时间
    lastHeartbeat = Date.now();

    // 心跳消息不需要处理
    if (data.type === 'heartbeat') {
        return;
    }

    console.log('收到数据:', data.type || 'unknown');

    switch (data.type) {
        case 'text':
            receiveText(data);
            break;
        case 'file-meta':
            receiveFileMeta(data);
            break;
        case 'file-chunk':
            receiveFileChunk(data);
            break;
        case 'file-complete':
            receiveFileComplete(data);
            break;
    }
}

// ===== 文件传输 =====

// 处理文件选择
function handleFileSelect(e) {
    handleFiles(e.target.files);
    e.target.value = ''; // 清空以便重复选择
}

// 处理文件
function handleFiles(files) {
    if (!connection || connection.open !== true) {
        showToast('请先建立连接', 'error');
        return;
    }

    Array.from(files).forEach(file => {
        sendFile(file);
    });
}

// 发送文件
async function sendFile(file) {
    const fileId = generateFileId();
    const totalChunks = Math.ceil(file.size / CONFIG.CHUNK_SIZE);

    // 显示发送列表
    elements.sendingFiles.classList.remove('hidden');

    // 创建文件项UI
    const fileItemEl = createFileItemElement(fileId, file.name, file.size, 'sending');
    elements.sendingFilesList.appendChild(fileItemEl);

    // 发送文件元数据
    connection.send({
        type: 'file-meta',
        fileId: fileId,
        name: file.name,
        size: file.size,
        fileType: file.type,
        totalChunks: totalChunks
    });

    // 分块发送文件
    let sentChunks = 0;

    for (let i = 0; i < totalChunks; i++) {
        const start = i * CONFIG.CHUNK_SIZE;
        const end = Math.min(start + CONFIG.CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);

        const arrayBuffer = await chunk.arrayBuffer();

        connection.send({
            type: 'file-chunk',
            fileId: fileId,
            chunkIndex: i,
            data: arrayBuffer
        });

        sentChunks++;
        const progress = (sentChunks / totalChunks) * 100;
        updateFileProgress(fileId, progress);

        // 添加小延迟避免阻塞
        if (i % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }

    // 发送完成信号
    connection.send({
        type: 'file-complete',
        fileId: fileId
    });

    // 更新UI状态
    updateFileStatus(fileId, 'completed');
    showToast(`文件 "${file.name}" 发送完成`, 'success');
}

// 接收文件元数据
function receiveFileMeta(data) {
    receivingFiles[data.fileId] = {
        meta: data,
        chunks: new Array(data.totalChunks),
        receivedSize: 0,
        lastUpdate: Date.now() // 记录开始时间
    };

    // 显示接收列表
    elements.receivedFiles.classList.remove('hidden');

    // 创建文件项UI
    const fileItemEl = createFileItemElement(
        data.fileId,
        data.name,
        data.size,
        'receiving'
    );
    elements.receivedFilesList.appendChild(fileItemEl);
}

// 接收文件块
function receiveFileChunk(data) {
    const fileData = receivingFiles[data.fileId];
    if (!fileData) return;

    fileData.chunks[data.chunkIndex] = data.data;
    fileData.receivedSize += data.data.byteLength;
    fileData.lastUpdate = Date.now(); // 更新最后接收时间

    const progress = (fileData.receivedSize / fileData.meta.size) * 100;
    updateFileProgress(data.fileId, progress);
}

// 文件接收完成
function receiveFileComplete(data) {
    const fileData = receivingFiles[data.fileId];
    if (!fileData) return;

    // 合并所有块
    const blob = new Blob(fileData.chunks, { type: fileData.meta.fileType });

    // 创建下载链接
    const url = URL.createObjectURL(blob);

    // 保存到已完成文件列表
    completedFiles[data.fileId] = {
        name: fileData.meta.name,
        size: fileData.meta.size,
        url: url,
        downloaded: false
    };

    // 更新UI
    updateFileStatus(data.fileId, 'completed', url, fileData.meta.name);
    showToast(`文件 "${fileData.meta.name}" 接收完成`, 'success');

    // 清理
    delete receivingFiles[data.fileId];
}

// 生成文件ID
function generateFileId() {
    return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// 创建文件项元素
function createFileItemElement(fileId, name, size, status) {
    const el = document.createElement('div');
    el.className = 'file-item';
    el.id = `file-${fileId}`;

    const icon = getFileIcon(name);
    const sizeStr = formatFileSize(size);

    el.innerHTML = `
        <span class="file-icon">${icon}</span>
        <div class="file-info">
            <div class="file-name" title="${name}">${name}</div>
            <div class="file-size">${sizeStr}</div>
            <div class="file-progress">
                <div class="file-progress-bar" style="width: 0%"></div>
            </div>
        </div>
        <span class="file-status ${status === 'sending' ? 'sending' : 'sending'}">
            ${status === 'sending' ? '发送中' : '接收中'}
        </span>
    `;

    return el;
}

// 更新文件进度
function updateFileProgress(fileId, progress) {
    const el = document.querySelector(`#file-${fileId} .file-progress-bar`);
    if (el) {
        el.style.width = `${progress}%`;
    }
}

// 更新文件状态
function updateFileStatus(fileId, status, downloadUrl, fileName) {
    const el = document.getElementById(`file-${fileId}`);
    if (!el) return;

    const statusEl = el.querySelector('.file-status');
    if (!statusEl) return;

    if (status === 'completed') {
        if (downloadUrl) {
            // 接收完成，显示下载按钮和未下载标记
            statusEl.outerHTML = `
                <div class="file-actions">
                    <span class="file-download-status not-downloaded" id="status-${fileId}">未下载</span>
                    <button class="file-download-btn" onclick="downloadFile('${downloadUrl}', '${fileName}', '${fileId}')">
                        ⬇️ 下载
                    </button>
                </div>
            `;
        } else {
            // 发送完成
            statusEl.className = 'file-status completed';
            statusEl.textContent = '已完成';
        }
    }
}

// 下载文件
function downloadFile(url, fileName, fileId) {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // 更新下载状态
    if (fileId && completedFiles[fileId]) {
        completedFiles[fileId].downloaded = true;

        // 更新UI状态
        const statusEl = document.getElementById(`status-${fileId}`);
        if (statusEl) {
            statusEl.className = 'file-download-status downloaded';
            statusEl.textContent = '已下载';
        }
    }

    showToast(`文件 "${fileName}" 正在下载`, 'success');
}

// 获取文件图标
function getFileIcon(fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    const icons = {
        // 图片
        'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'webp': '🖼️', 'svg': '🖼️',
        // 文档
        'pdf': '📕', 'doc': '📘', 'docx': '📘', 'txt': '📝', 'md': '📝',
        // 表格
        'xls': '📊', 'xlsx': '📊', 'csv': '📊',
        // 演示
        'ppt': '📙', 'pptx': '📙',
        // 压缩
        'zip': '📦', 'rar': '📦', '7z': '📦', 'tar': '📦', 'gz': '📦',
        // 视频
        'mp4': '🎬', 'avi': '🎬', 'mkv': '🎬', 'mov': '🎬', 'webm': '🎬',
        // 音频
        'mp3': '🎵', 'wav': '🎵', 'flac': '🎵', 'aac': '🎵',
        // 代码
        'js': '💻', 'py': '💻', 'html': '💻', 'css': '💻', 'json': '💻',
        // 可执行
        'exe': '⚙️', 'msi': '⚙️', 'apk': '📱'
    };

    return icons[ext] || '📄';
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ===== 文本传输 =====

// 发送文本
function sendText() {
    const text = elements.textInput.value.trim();

    if (!text) {
        showToast('请输入要发送的文本', 'error');
        return;
    }

    if (!connection || connection.open !== true) {
        showToast('请先建立连接', 'error');
        return;
    }

    connection.send({
        type: 'text',
        content: text,
        timestamp: Date.now()
    });

    elements.textInput.value = '';
    showToast('文本已发送', 'success');
}

// 接收文本
function receiveText(data) {
    elements.receivedTexts.classList.remove('hidden');

    const time = new Date(data.timestamp).toLocaleTimeString();

    const el = document.createElement('div');
    el.className = 'text-message';
    el.innerHTML = `
        <div class="text-message-content">${escapeHtml(data.content)}</div>
        <div class="text-message-time">${time}</div>
        <button class="text-message-copy" onclick="copyTextContent(this)">复制</button>
    `;

    elements.textMessages.insertBefore(el, elements.textMessages.firstChild);
    showToast('收到新文本');
}

// 复制文本内容
function copyTextContent(btn) {
    const content = btn.parentElement.querySelector('.text-message-content').textContent;
    navigator.clipboard.writeText(content).then(() => {
        showToast('已复制到剪贴板', 'success');
    }).catch(() => {
        showToast('复制失败', 'error');
    });
}

// HTML转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===== 工具函数 =====

// 复制房间码
function copyRoomCode() {
    navigator.clipboard.writeText(currentRoomCode).then(() => {
        showToast('房间码已复制', 'success');
    }).catch(() => {
        showToast('复制失败', 'error');
    });
}

// 显示Toast消息
function showToast(message, type = '') {
    const toast = elements.toast;
    toast.textContent = message;
    toast.className = 'toast ' + type;

    // 触发重绘以重置动画
    toast.offsetHeight;

    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// 暴露全局函数
window.downloadFile = downloadFile;
window.copyTextContent = copyTextContent;

// 启动应用
init();
