document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM fully loaded and parsed');
    // 在这里初始化 Socket 连接
    const socket = io(); // Initialize the globally declared socket

    // 获取视图元素 (假设有这些视图，您可能需要根据实际情况修改ID)
    const lobbyView = document.getElementById('lobby-view');

    // 获取认证相关的DOM元素
    const authView = document.getElementById('auth-view');
    const loginForm = document.getElementById('login-form');
    const registerForm = document.getElementById('register-form');
    const loginUsernameInput = document.getElementById('login-username');
    const loginPasswordInput = document.getElementById('login-password');
    const loginButton = document.getElementById('login-button');
    const registerUsernameInput = document.getElementById('register-username');
    const registerPasswordInput = document.getElementById('register-password');
    const registerButton = document.getElementById('register-button');
    const showRegisterLink = document.getElementById('show-register');
    const showLoginLink = document.getElementById('show-login');
    const authErrorElement = document.getElementById('authError'); // Assuming an element to display errors

    // 切换表单显示
    showRegisterLink.addEventListener('click', (e) => {
        e.preventDefault();
        loginForm.style.display = 'none';
        registerForm.style.display = 'block';
    });

    showLoginLink.addEventListener('click', (e) => {
        e.preventDefault();
        registerForm.style.display = 'none';
        loginForm.style.display = 'block';
    });

    // 登录按钮点击事件
    loginButton.addEventListener('click', () => {
        const username = loginUsernameInput.value;
        const password = loginPasswordInput.value;
        console.log('尝试登录:', username, password);
        socket.emit('login', { username, password });
    });

    // 注册按钮点击事件
    registerButton.addEventListener('click', () => {
        const phoneNumber = registerUsernameInput.value; // 将输入框的值视为手机号
        const password = registerPasswordInput.value;
        socket.emit('register', { phoneNumber, password });
    });

    // 处理特定的 Socket 事件。
    socket.on('authSuccess', (data) => {
        console.log('认证成功:', data);
        // 在这里处理认证成功后的逻辑，例如切换到大厅视图
        const authView = document.getElementById('auth-view');
        const lobbyView = document.getElementById('lobby-view');
        if (authView) authView.classList.add('hidden-view'); // Hide auth view
        if (lobbyView) lobbyView.classList.remove('hidden-view'); // Show lobby view
        // 存储用户信息，例如：localStorage.setItem('user', JSON.stringify(data));
    });

    socket.on('authFailed', (errorMessage) => {
        console.error('认证失败:', errorMessage);
        if (authErrorElement) {
            authErrorElement.textContent = errorMessage;
        }
    });

    socket.on('roomListUpdate', (roomListData) => {
        console.log('房间列表更新:', roomListData);
        // 在这里更新页面上的房间列表显示
    });

    // 您还需要添加其他事件的监听器，例如加入房间成功、玩家加入/离开房间等

    // 在这里添加其他初始化代码，例如设置事件监听器，初始化视图等
});