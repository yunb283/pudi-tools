function generateMap(){
	var sprites = Array.from(pupu.children).filter(function (image) { return image.naturalWidth > 0; });

	var bgcol = document.getElementById('bgcol').value;
	var iters = document.getElementById('iterations').value;
	var bgits = document.getElementById('bgits').value;

	seamlsmode = $('#seamlsmode:checked').val();
	var rotatemode = $('#rotatemode:checked').val();
	var mirrormode = $('#mirrormode:checked').val();
	var blendimode = $('#blendimode:checked').val();
	var alphamode = $('#alphamode:checked').val();

	ctx.globalCompositeOperation = "source-over";
	ctx.fillStyle = "rgb(" + bgcol + "," + bgcol + "," + bgcol + ")";
	ctx.fillRect(-cord, -cord, res, res);

	var minime = 125-document.getElementById('minsize').value;
	var maxime = minime*1.5;

	if(bgits != "0" && sprites.length){
		var bets = 1;
		for(i = 1; i <= bgits; i++){
			for(yi = -cord; yi <= cord; yi+=(res/bets)){
				for(xi = -cord; xi <= cord; xi+=(res/bets)){
					var img = sprites[rand(0, sprites.length - 1)];
					ctx.drawImage(img,xi,yi,res/bets,res/bets);
				}
			}
			bets++;
		}
	}

	for (var i = 0; i < iters && sprites.length; i++) {
		if(seamlsmode == "1"){
			var scale = (res/rand(maxime,minime))*rand(10,25);
			var posx = rand(-res,res);
			var posy = rand(-res,res);
		}
		else{
			var scale = (res/rand(maxime,minime))*rand(10,25);
			var posx = rand(-cord-(cord/4),cord);
			var posy = rand(-cord-(cord/4),cord);
		}

		var img = sprites[rand(0, sprites.length - 1)];

		if(rotatemode == "1"){
			var roota = rand(0,3)*90; // 0, 90, 180, 270
			if(roota != 0){ctx.rotate(roota*Math.PI/180);}
		}

		if(mirrormode == "1"){
			var flip = rand(0,1);
			if(flip == "0"){ ctx.scale(-1,1); }
		}

		var mood = rand(0,mode.length-1);

		if(blendimode == "1"){
			ctx.globalCompositeOperation = mode[mood];
		}

		ctx.drawImage(img,posx,posy,scale,scale);

		if(seamlsmode == "1"){
			if((posx+scale >= cord) && (posy+scale >= cord)){
				posx = posx-res;
				ctx.drawImage(img,posx,posy,scale,scale);
				posy = posy-res;
				ctx.drawImage(img,posx,posy,scale,scale);
				posx = posx+res;
				ctx.drawImage(img,posx,posy,scale,scale);
			}
			else if((posx <= -cord) && (posy+scale >= cord)){
				posx = posx+res;
				ctx.drawImage(img,posx,posy,scale,scale);
				posy = posy-res;
				ctx.drawImage(img,posx,posy,scale,scale);
				posx = posx-res;
				ctx.drawImage(img,posx,posy,scale,scale);
			}
			else if((posx+scale >= cord) && (posy <= -cord)){
				posx = posx-res;
				ctx.drawImage(img,posx,posy,scale,scale);
				posy = posy+res;
				ctx.drawImage(img,posx,posy,scale,scale);
				posx = posx+res;
				ctx.drawImage(img,posx,posy,scale,scale);
			}
			else if((posx <= -cord) && (posy <= -cord)){
				posx = posx+res;
				ctx.drawImage(img,posx,posy,scale,scale);
				posy = posy+res;
				ctx.drawImage(img,posx,posy,scale,scale);
				posx = posx-res;
				ctx.drawImage(img,posx,posy,scale,scale);
			}


			else if(posx+scale >= cord){
				posx = posx-res;
				ctx.drawImage(img,posx,posy,scale,scale);
			}
			else if(posx <= -cord){
				posx = posx+res;
				ctx.drawImage(img,posx,posy,scale,scale);
			}
			else if(posy+scale >= cord){
				posy = posy-res;
				ctx.drawImage(img,posx,posy,scale,scale);
			}
			else if(posy <= -cord){
				posy = posy+res;
				ctx.drawImage(img,posx,posy,scale,scale);
			}
		}

		if(mirrormode == "1"){
			if(flip == "0"){ ctx.scale(-1,1); }
		}

		if(rotatemode == "1"){
			if(roota != 0){ctx.rotate(-roota*Math.PI/180);}
		}
	}
}

var spritePacks = {
	spritea: 'JS2Classic',
	spriteb: 'CrapPack',
	spritec: 'BigData',
	sprited: 'Aggromaxx',
	spritecustom: 'JS2Classic',
};

$('input:radio[name=spriteset]').on('change', function () {
	spriteSet(spritePacks[this.value]);
});

var mode = [
	"source-over",
	"source-over",
	"source-over",
	"darken",
	"lighten"
];

var pupu = document.getElementById("imgs");

var cord = res/2;

ctx.translate(cord,cord);

var spriteImagesReady;
var prepareGenerator = async function () {
	var target = canvas;
	var pending;
	do {
		pending = spriteImagesReady;
		await pending;
	} while (canvas === target && pending !== spriteImagesReady);
};

spriteSet("JS2Classic");

function spriteSet(dir){
	var path = __dirname + '/JS2sprites/' + (dir === 'CustomSprites' ? 'JS2Classic' : dir);
	var fragment = document.createDocumentFragment();
	var pending = [];
	for (let file of fs.readdirSync(path)) {
		if (!/\.(svg|png)$/i.test(file)) continue;
		let img = new Image();
		pending.push(new Promise(function (resolve) {
			img.onload = img.onerror = resolve;
		}));
		img.src = path + '/' + file;
		fragment.appendChild(img);
	}
	pupu.replaceChildren(fragment);
	spriteImagesReady = Promise.all(pending);
}
