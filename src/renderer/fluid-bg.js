"use strict";

/* Fluid gradient background: a low-res WebGL canvas running a simplex-noise
 * fragment shader (domain-warped fbm), blurred by CSS and tinted with the
 * current cover palette. Falls back silently to the #ambient CSS gradient
 * when WebGL is unavailable. Exposes window.FluidBg.setColors(base, a, b)
 * with hex colors; transitions between palettes are lerped on the GPU side
 * (uniforms), so track changes fade smoothly. */
(function () {
	const canvas = document.getElementById("bg-canvas");
	const gl = canvas.getContext("webgl", {
		antialias: false,
		depth: false,
		alpha: false,
		powerPreference: "low-power",
	});
	if (!gl) return; // no WebGL — the CSS gradient on #ambient stays visible

	const VERT =
		"attribute vec2 a_pos;" +
		"void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }";

	const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_c0; /* dark base */
uniform vec3 u_c1; /* accent A  */
uniform vec3 u_c2; /* accent B  */

/* 2D simplex noise (Ashima Arts, MIT) */
vec3 permute(vec3 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
float snoise(vec2 v){
	const vec4 C = vec4(0.211324865405187, 0.366025403784439,
		-0.577350269189626, 0.024390243902439);
	vec2 i  = floor(v + dot(v, C.yy));
	vec2 x0 = v - i + dot(i, C.xx);
	vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
	vec4 x12 = x0.xyxy + C.xxzz;
	x12.xy -= i1;
	i = mod(i, 289.0);
	vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
		+ i.x + vec3(0.0, i1.x, 1.0));
	vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
	m = m*m; m = m*m;
	vec3 x = 2.0 * fract(p * C.www) - 1.0;
	vec3 h = abs(x) - 0.5;
	vec3 ox = floor(x + 0.5);
	vec3 a0 = x - ox;
	m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
	vec3 g;
	g.x  = a0.x  * x0.x  + h.x  * x0.y;
	g.yz = a0.yz * x12.xz + h.yz * x12.yw;
	return 130.0 * dot(m, g);
}

float fbm(vec2 p){
	float v = 0.0;
	float a = 0.55;
	for (int i = 0; i < 4; i++){
		v += a * snoise(p);
		p = p * 2.03 + 11.7;
		a *= 0.5;
	}
	return v;
}

void main(){
	vec2 uv = gl_FragCoord.xy / u_res;
	vec2 p = uv;
	p.x *= u_res.x / u_res.y;
	p *= 1.7;
	float t = u_time * 0.05;

	/* domain warping — the "liquid" deformation */
	vec2 q = vec2(fbm(p + vec2(t, -t * 0.6)),
	              fbm(p + vec2(4.7, 2.3) - t * 0.8));
	float n = fbm(p + 2.4 * q);

	float m1 = smoothstep(-0.35, 0.65, n);
	float m2 = smoothstep(-0.10, 0.85,
		fbm(p * 0.6 - vec2(t * 0.5, t * 0.4)) + 0.45 * n);

	vec3 col = u_c0;
	col = mix(col, u_c1, m1 * 0.50);
	col = mix(col, u_c2, m2 * 0.55);

	/* gentle corner darkening keeps text contrast stable */
	vec2 e = abs(uv - 0.5);
	float edge = smoothstep(0.75, 0.30, max(e.x, e.y));
	col = mix(col * 0.80, col, edge);

	gl_FragColor = vec4(col, 1.0);
}`;

	function compile(type, src) {
		const s = gl.createShader(type);
		gl.shaderSource(s, src);
		gl.compileShader(s);
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
			console.error("[bg] shader:", gl.getShaderInfoLog(s));
			return null;
		}
		return s;
	}

	const vs = compile(gl.VERTEX_SHADER, VERT);
	const fs = compile(gl.FRAGMENT_SHADER, FRAG);
	if (!vs || !fs) return;

	const prog = gl.createProgram();
	gl.attachShader(prog, vs);
	gl.attachShader(prog, fs);
	gl.linkProgram(prog);
	if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
		console.error("[bg] link:", gl.getProgramInfoLog(prog));
		return;
	}
	gl.useProgram(prog);

	// fullscreen quad
	const buf = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buf);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
		-1, -1, 1, -1, -1, 1, 1, 1,
	]), gl.STATIC_DRAW);
	const loc = gl.getAttribLocation(prog, "a_pos");
	gl.enableVertexAttribArray(loc);
	gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

	const uRes = gl.getUniformLocation(prog, "u_res");
	const uTime = gl.getUniformLocation(prog, "u_time");
	const uC = [
		gl.getUniformLocation(prog, "u_c0"),
		gl.getUniformLocation(prog, "u_c1"),
		gl.getUniformLocation(prog, "u_c2"),
	];

	function hexToRgb01(hex) {
		const n = parseInt(hex.slice(1), 16);
		return [
			((n >> 16) & 255) / 255,
			((n >> 8) & 255) / 255,
			(n & 255) / 255,
		];
	}

	// defaults match the CSS palette so the first frame isn't a flash
	const cur = [
		hexToRgb01("#141312"),
		hexToRgb01("#8a72d0"),
		hexToRgb01("#1c1917"),
	];
	const target = cur.map((c) => c.slice());

	function resize() {
		// low internal resolution: the CSS blur hides it, the GPU cost is nil
		const w = Math.max(120, Math.floor(window.innerWidth * 0.16));
		const h = Math.max(80, Math.floor(window.innerHeight * 0.16));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
			gl.viewport(0, 0, w, h);
		}
	}
	window.addEventListener("resize", resize);
	resize();

	window.FluidBg = {
		setColors(base, accentA, accentB) {
			target[0] = hexToRgb01(base);
			target[1] = hexToRgb01(accentA);
			target[2] = hexToRgb01(accentB);
		},
	};

	let last = performance.now();
	function frame(now) {
		const dt = Math.min(100, now - last);
		last = now;

		// ease uniforms toward the target palette (~1.5s settle)
		const k = 1 - Math.exp(-dt / 450);
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 3; j++) {
				cur[i][j] += (target[i][j] - cur[i][j]) * k;
			}
			gl.uniform3fv(uC[i], cur[i]);
		}
		gl.uniform2f(uRes, canvas.width, canvas.height);
		gl.uniform1f(uTime, now / 1000);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

		requestAnimationFrame(frame);
	}
	requestAnimationFrame(frame);

	// fade in only after the first frame is on screen
	requestAnimationFrame(() => canvas.classList.add("on"));
})();
