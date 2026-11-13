// 所有生成器按原版 8192 坐标排布，画布只分配实际输出所需的像素。
var res = 8192;
var canvas = document.getElementById('dis');
var colorCanvas = document.getElementById('dat');
var outputSize = window.SFTEX_RES || 1024;
canvas.width = canvas.height = outputSize;
colorCanvas.width = colorCanvas.height = outputSize;
var ctx = canvas.getContext('2d');
var pixelScale = outputSize / res;
ctx.scale(pixelScale, pixelScale);
ctx.imageSmoothingQuality = 'high';

var undoCanvas = document.createElement('canvas');
undoCanvas.width = undoCanvas.height = outputSize;
var undoctx = undoCanvas.getContext('2d');

var normalCanvas = document.getElementById('sf-normal-preview');
var normalToggle = document.querySelector('.sf-normal-toggle');
var heightToggle = document.querySelector('.sf-height-toggle');
var gradientToggle = document.querySelector('.sf-gradient-toggle');
var normalDirty = true;
normalCanvas.addEventListener('click', refresh);
heightToggle.addEventListener('click', function () { showHeight(1); });
gradientToggle.addEventListener('click', function () { showRandomGradient(); });
normalToggle.addEventListener('click', function () {
	if (!normalCanvas.hidden) {
		setNormalVisible(false);
		return;
	}
	schedulePreviewUpdate(function () {
		getNormalMap();
		setNormalVisible(true);
	});
});

function setNormalVisible(visible) {
	normalCanvas.hidden = !visible;
	syncPreviewButtons();
}

function syncPreviewButtons() {
	var disabled = canvas.getAttribute('generated') !== 'yup' ||
		canvas.closest('.canvasbox').hasAttribute('aria-busy');
	var normal = !normalCanvas.hidden;
	var gradient = !normal && canvas.classList.contains('hidden');
	for (var [button, active] of [[normalToggle, normal], [gradientToggle, gradient], [heightToggle, !normal && !gradient]]) {
		button.disabled = disabled;
		button.classList.toggle('on', active);
		button.setAttribute('aria-pressed', String(active));
	}
}

function invalidateNormalMap() {
	normalDirty = true;
	if (!normalCanvas.hidden) getNormalMap();
}

// Keep the current image visible while a generation or palette update is pending.
function schedulePreviewUpdate(update) {
	var target = canvas;
	if (!target) return;
	var preview = target.closest('.canvasbox');
	var request = (target.previewRequest || 0) + 1;
	target.previewRequest = request;
	var isCurrent = () => canvas === target && target.previewRequest === request;
	preview.setAttribute('aria-busy', 'true');
	syncPreviewButtons();
	setTimeout(async function(){
		if (!isCurrent()) return;
		try {
			await update(target, isCurrent);
		} finally {
			if (isCurrent()) {
				preview.removeAttribute('aria-busy');
				syncPreviewButtons();
			}
		}
	}, 0);
}

function refresh(){
	schedulePreviewUpdate(async function (target, isCurrent) {
		if (typeof prepareGenerator === 'function') {
			await prepareGenerator();
			if (!isCurrent()) return;
		}
		var alreadyGenerated = target.getAttribute('generated') === 'yup';
		if (alreadyGenerated) {
			undoctx.clearRect(0, 0, target.width, target.height);
			undoctx.drawImage(target, 0, 0);
		}
		setTimestamp();
		ctx.clearRect(-res*2, -res*2, res*4, res*4);
		generateMap();
		invalidateNormalMap();
		uncolor();
		$('.actionbox a').removeClass('disabled');
		if (!alreadyGenerated) {
			target.setAttribute('generated', 'yup');
			$('.actionbox a.undo').addClass('disabled');
		}
	});
}

// Undo
function undoMap(){
	setTimestamp();
	uncolor();
	ctx.save();
	ctx.resetTransform();
	ctx.globalCompositeOperation = 'copy';
	ctx.drawImage(undoCanvas, 0, 0);
	ctx.restore();
	invalidateNormalMap();
}

// Invert map
function invertMap(){
	setTimestamp();
	uncolor();
	ctx.save();
	ctx.resetTransform();
	ctx.globalCompositeOperation="difference";

	ctx.fillStyle = "rgb(255,255,255)";
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	ctx.restore();
	invalidateNormalMap();
}

// View controls

function showHeight(y){
	canvas.classList.toggle('hidden', y === 0);
	setNormalVisible(false);
}


// Save height
function saveHeight(savename){
	savename += timestamp;
	if(seamlsmode == "1"){
		savename += "-Seamless";
	}
	savename += ".png";

	canvas.toBlob(function(blob) {
		saveAs(blob, savename);
	});
}

// Preview and export share the same full-resolution normal map.
function getNormalMap(){
	if (!normalDirty) return normalCanvas;
	var width = canvas.width;
	var height = canvas.height;
	if (normalCanvas.width !== width || normalCanvas.height !== height) {
		normalCanvas.width = width;
		normalCanvas.height = height;
	}
	var ctxnorm = normalCanvas.getContext('2d');
	var stride = width * 4;
	var rowsPerChunk = 256;
	var destination = ctxnorm.createImageData(width, Math.min(rowsPerChunk, height));
	var data = destination.data;
	// Read one extra row on each side so the derivative stays continuous across chunk boundaries.
	for (var top = 0; top < height; top += rowsPerChunk) {
		var rows = Math.min(rowsPerChunk, height - top);
		var sourceTop = Math.max(0, top - 1);
		var sourceEnd = Math.min(height, top + rows + 1);
		var source = ctx.getImageData(0, sourceTop, width, sourceEnd - sourceTop).data;
		var offset = (top - sourceTop) * stride;
		for (var y = 0; y < rows; y++) {
			var up = top + y === 0 ? 0 : stride;
			var down = top + y === height - 1 ? 0 : stride;
			for (var x = 0; x < width; x++) {
				var i = y * stride + x * 4;
				var sample = i + offset;
				var left = x === 0 ? sample : sample - 4;
				var right = x === width - 1 ? sample : sample + 4;
				data[i] = source[left] - source[right] + 127;
				data[i + 1] = source[sample - up] - source[sample + down] + 127;
				data[i + 2] = 255;
				data[i + 3] = 255;
			}
		}
		ctxnorm.putImageData(destination, 0, top, 0, 0, width, rows);
	}
	normalDirty = false;
	return normalCanvas;
}

function saveNormal(savename){
	savename += timestamp;
	if(seamlsmode == "1"){
		savename += "-Seamless";
	}
	savename += "-Normal";
	savename += ".png";

	getNormalMap().toBlob(function(blob) {
		saveAs(blob, savename);
	});
}

// Calculate date

function setTimestamp(){
	if(cfg.General.timestampFormat == 0){
		timestamp = Math.floor(Date.now() / 1000);
	}
	if(cfg.General.timestampFormat == 1){
		timestamp = realDate();
	}
	else{
		timestamp = compactDate();
	}
}

function realDate(){
  var date = new Date();
  var str = date.getFullYear() + '-' + ('0' + (date.getMonth()+1)).slice(-2) + '-' + ('0' + date.getDate()).slice(-2) + '-' + ('0' + date.getHours()).slice(-2)+ '-' + ('0' + date.getMinutes()).slice(-2) + '-' + ('0' + date.getSeconds()).slice(-2);
  return str;
}

function compactDate(){
  var date = new Date();
  var str = date.getFullYear() + ('0' + (date.getMonth()+1)).slice(-2) + ('0' + date.getDate()).slice(-2) + ('0' + date.getHours()).slice(-2) + ('0' + date.getMinutes()).slice(-2) + ('0' + date.getSeconds()).slice(-2);
  return str;
}
