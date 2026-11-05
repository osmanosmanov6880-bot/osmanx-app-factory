for(const form of document.querySelectorAll('form[data-site-lead]')){
  form.addEventListener('submit',async e=>{
    e.preventDefault();const button=form.querySelector('[type="submit"]'),message=form.querySelector('.form-message');
    button.disabled=true;message.textContent='Отправляем обращение…';message.className='form-message';
    const values=Object.fromEntries(new FormData(form));
    try{
      const response=await fetch(form.dataset.api,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...values,page:form.dataset.siteLead})});
      const data=await response.json();if(!response.ok)throw Error(data.error||'Не удалось отправить обращение');
      message.textContent='Спасибо! Сообщение успешно отправлено.';message.classList.add('success');form.reset();
    }catch(err){message.textContent=err.message||'Ошибка соединения';message.classList.add('error');}
    finally{button.disabled=false;}
  });
}
