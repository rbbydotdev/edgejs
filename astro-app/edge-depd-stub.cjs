module.exports = function depd() {
	function deprecate() {}
	deprecate.function = function wrapFunction(fn) {
		return fn;
	};
	deprecate.property = function wrapProperty() {};
	return deprecate;
};
