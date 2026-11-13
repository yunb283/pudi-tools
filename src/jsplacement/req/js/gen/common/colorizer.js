// Save color
function saveColor(savename){
	savename += timestamp;
	if(seamlsmode == "1"){
		savename += "-Seamless";
	}
	savename += "-Color";
	savename += ".png";

	colorCanvas.toBlob(function(blob) {
		saveAs(blob, savename);
	});
}

// Both preview controls use the bundled gradient palettes.
var gradientFiles = fs.readdirSync(__dirname + '/Gradients')
	.filter(file => /\.(jpe?g|png|gif|bmp)$/i.test(file));
var selectedGradient = null;

function gradientSource(file) {
	return './Gradients/' + file;
}


function loadGrad(){
	var panel = document.getElementById('colorizer');
	if (!panel) return;
	var gradients = panel.querySelector('#gradients');
	if (gradients?.childElementCount) return;
	if (!gradients) {
		gradients = document.createElement('span');
		gradients.id = 'gradients';
		panel.appendChild(gradients);
	}
	for (var file of gradientFiles) {
		var image = new Image();
		image.id = file;
		image.src = gradientSource(file);
		image.addEventListener('click', function () { theColorizer(this.id); });
		gradients.appendChild(image);
	}
}

var colorctx = colorCanvas.getContext('2d');

function showRandomGradient() {
	var choices = gradientFiles.filter(file => file !== selectedGradient);
	if (!choices.length) choices = gradientFiles;
	if (choices.length) theColorizer(choices[rand(0, choices.length - 1)]);
}

function theColorizer(file){
	if (!colorCanvas || canvas.getAttribute('generated') !== 'yup') return;
	schedulePreviewUpdate(async function (_, isCurrent) {
		var palette = document.getElementById(file);
		if (!palette?.naturalWidth) {
			palette = new Image();
			palette.src = gradientSource(file);
			try {
				await palette.decode();
			} catch {
				return;
			}
			if (!isCurrent()) return;
		}
		applyGradient(palette);
		selectedGradient = file;
		showHeight(0);
	});
}

function applyGradient(palette) {
	var paletteCanvas = document.createElement('canvas');
	paletteCanvas.width = 256;
	paletteCanvas.height = 1;
	var palettectx = paletteCanvas.getContext('2d');
	palettectx.drawImage(palette, 0, 0, 256, 1);
	var colors = palettectx.getImageData(0, 0, 256, 1).data;

	var width = colorCanvas.width;
	var height = colorCanvas.height;
	var rowsPerChunk = 256;
	for (var top = 0; top < height; top += rowsPerChunk) {
		var rows = Math.min(rowsPerChunk, height - top);
		var pixels = ctx.getImageData(0, top, width, rows);
		var data = pixels.data;
		for (var i = 0; i < data.length; i += 4) {
			var index = data[i] * 4;
			data[i] = colors[index];
			data[i + 1] = colors[index + 1];
			data[i + 2] = colors[index + 2];
			data[i + 3] = 255;
		}
		colorctx.putImageData(pixels, 0, top);
	}
}

function uncolor(){
	canvas.classList.remove('hidden');
	colorctx.clearRect(0, 0, colorCanvas.width, colorCanvas.height);
	syncPreviewButtons();
}
