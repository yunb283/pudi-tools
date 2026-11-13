// attach static images to the document
(() => {
  const container = document.createElement('div');
  container.id = 'imgs';
  for (i = 0; i < files.length; i++){
    // 嵌入版：相对 iframe 文档路径，不能再用站点根路径 "/"
    container.innerHTML = container.innerHTML + "<img src=\"" + files[i] + "\" id=\"" + files[i] + "\" />";
  }
  document.body.appendChild(container);
})();
