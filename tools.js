module.exports = {

    startsWith: function (s,p) {
        var pl = p.length;
        if(s.length < pl) return false;
        return s.substr(0,pl) == p;
    },

    formattedDate: function(rd){

        var today = rd;
        var dd = this.padNum(today.getDate(),1);
        var mm = this.padNum(today.getMonth()+1,1);//January is 0!
        var yyyy = today.getFullYear();
        var hours = this.padNum(today.getHours(),2);
        var minutes = this.padNum(today.getMinutes(),2);
        var seconds = this.padNum(today.getSeconds(),2);
        if(dd<10){dd='0'+dd}
        if(mm<10){mm='0'+mm}
        return mm+'/'+dd+'/'+yyyy+' '+hours+':'+minutes+':'+seconds;
    },

    padNum: function(num, places) {
        num = parseInt(num);
        var zero = places - num.toString().length + 1;
        return Array(+(zero > 0 && zero)).join("0") + num;
    },

    getLastWordOfURL: function(s){
        var afterLastSlash = s.substr(s.lastIndexOf("/")+1);
        var c;
        if( s.indexOf("?") != -1 ){
            c = afterLastSlash.substr(0,afterLastSlash.indexOf("?"));
        }else{
            c = afterLastSlash;
        }
        return c;
    },

    stripQryStr: function(url){
       return url.substr(0,url.lastIndexOf("?"));
    },

    guid: function(){
        var S4 = function () {
            return Math.floor(
                Math.random() * 0x10000 /* 65536 */
            ).toString(16);
        };
        return (
            S4() + S4() + "-" +
                S4() + "-" +
                S4() + "-" +
                S4() + "-" +
                S4() + S4() + S4()
            );
    },

    logd: function(msg){
        console.log('['+this.formattedDate(new Date())+'] ' + msg);
    }

};

String.prototype.endsWith = function(suffix) {
    return this.indexOf(suffix, this.length - suffix.length) !== -1;
};
