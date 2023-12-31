import { promisify } from 'util';
import jwt from 'jsonwebtoken';
import { User } from '../models/userModel.js';
import { AppError } from '../utils/errors.js';
import Email from '../utils/email.js';
import { frontEndUrl } from '../server.js';
import crypto from 'crypto';
/// FUNCTION THAT SIGNS A JWT TOKEN WITH CONFIGURATION INFO TAKEN FROM ENV VARIABLES
const signToken = (id) => {
	return jwt.sign({ id }, process.env.JWT_SECRET, {
		expiresIn: process.env.JWT_EXPIRES_IN,
	});
};
/// CREATES AND SEND THE TOKEN, SOME CONFIGURATIONS CHANGE BASED ON THE ENVIROMENT
const createSendToken = (user, statusCode, res) => {
	const token = signToken(user._id);

	const cookieOptions = {
		expires: new Date(
			Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
		),
		origin: frontEndUrl,
		httpOnly: true,
	};
	if (process.env.NODE_ENV === 'production') {
		cookieOptions.secure = true;
		cookieOptions.sameSite = 'none';
	}
	///SETS THE PASSWORD TO UNDEFINED TO AVOID SENDING IT TO THE CLIENT
	user.password = undefined;

	res.cookie('jwt', token, cookieOptions).status(statusCode).json({
		status: 'success',
		token,
		data: {
			user,
		},
	});
};

export class AuthController {
	///HANDLES SIGNUP, CREATES A USER WITH FORM DATA
	static async signup(req, res, next) {
		try {
			const { email, password, passwordConfirm, budget } = req.body;
			const newUser = await User.create({
				email,
				password,
				passwordConfirm,
			});
			createSendToken(newUser, 201, res);
		} catch (err) {
			next(err);
		}
	}
	/// HANDLES LOGIN
	static async login(req, res, next) {
		try {
			const { email, password } = req.body;

			if (!email || !password) {
				return next(new AppError('Please provide email and password', 400));
			}

			const user = await User.findOne({ email }).select('+password');
			if (!user || !(await user.correctPassword(password, user.password))) {
				return next(new AppError('Incorrect email or password', 401));
			}

			createSendToken(user, 200, res);
		} catch (err) {
			next(err);
		}
	}
	/// HANDLES LOGOUT UPDATING JWT TOKEN WITH AN EMPTY ONE WITH AN IMMEDIATE EXPIRATION DATE
	static async logout(req, res) {
		const cookieOptions = {
			expires: new Date(Date.now()),
			origin: frontEndUrl,
			overwrite: true,
			httpOnly: true,
		};

		if (process.env.NODE_ENV === 'production') {
			cookieOptions.secure = true;
			cookieOptions.sameSite = 'none';
		}
		res.cookie('jwt', '', cookieOptions);
		res.status(200).json({ status: 'success' });
	}
	/// MIDDLEWARE THAT HANDLES PROTECTED ROUTES - CHECKS IF JWT TOKEN IS VALID
	static async protect(req, res, next) {
		try {
			// 	CHECK IF JWT TOKEN EXISTS
			let token = req.cookies.jwt;

			if (!token) {
				return next(
					new AppError(
						'You are not logged in! Please log in to get accesss',
						401
					)
				);
			}
			try {
				/// VERIFY JWT TOKEN
				const decoded = await promisify(jwt.verify)(
					token,
					process.env.JWT_SECRET
				);
				/// CHECK IF THE USER STILL EXISTS
				const freshUser = await User.findById(decoded.id);
				if (!freshUser) {
					return next(new AppError('The user no longer exists', 401));
				}
				// CHECK IF USER CHANGED PASSWORD
				if (freshUser.changedPasswordAfter(decoded.iat)) {
					return next(
						new AppError(
							'User recently changed password, please log in again',
							401
						)
					);
				}
				/// SETS A USER OBJECT IN THE REQ THAT CONTAINS THE USERINFO, SO THAT THE NEXT MIDDLEWARE CAN ACCESS THOSE INFO (E.G. req.user._id)
				req.user = freshUser;
				return next();
			} catch (err) {
				return next(new AppError('Invalid token. Please log in again', 401));
			}
		} catch (err) {
			return next(err);
		}
	}

	/////
	static async forgotPassword(req, res) {
		const user = await User.findOne({ email: req.body.email });
		if (!user)
			return next(
				new AppError('There is no user with that email address', 404)
			);

		const resetToken = user.createPasswordResetToken();
		await user.save({ validateBeforeSave: false });

		const resetURL = `${req.protocol}://${req.get(
			'host'
		)}/api/users/resetPassword/${resetToken}`;

		const message = `Forgot your password? Submit a patch request with yout new password and passwordConfirm to ${resetURL}`;

		try {
			new Email(user, resetURL).sendReset(message);

			res.status(200).json({
				status: 'success',
				message: 'Token sent to email',
			});
		} catch (err) {
			user.passworResetToken = undefined;
			user.passwordResetExpires = undefined;
			await user.save({ validateBeforeSave: false });

			return next(
				new AppError(
					'There was an error sending the email. Try again later',
					500
				)
			);
		}
	}
	static async resetPassword(req, res, next) {
		// GET USER BASED ON THE TOKEN
		const hashedToken = crypto
			.createHash('sha256')
			.update(req.params.token)
			.digest('hex');

		const user = await User.findOne({
			passwordResetToken: hashedToken,
			passwordResetExpires: { $gt: Date.now() },
		});

		//IF TOKEN HAS NOT EXPIRED AND THERE IS A USER, SET THE NEW PASSWORD
		if (!user) {
			return next(new AppError('Token is invalid or has expired', 400));
		}
		user.password = req.body.password;
		user.passwordConfirm = req.body.passwordConfirm;
		user.passworResetToken = undefined;
		user.passwordResetExpires = undefined;
		await user.save();

		// LOG THE USER IN, SEND JWT
		createSendToken(user, 200, res);
	}

	static async updatePassword(req, res, next) {
		/// GET THE USER
		const user = await User.findById(req.user._id).select('+password');
		/// CHECK IF PASSWORD IS CORRECT
		if (
			!(await user.correctPassword(req.body.currentPassword, user.password))
		) {
			return next(new AppError('Incorrect password', 401));
		}
		/// UPDATE THE PASSWORD
		user.password = req.body.password;
		user.passwordConfirm = req.body.passwordConfirm;
		await user.save();

		/// LOG THE USER IN, SEND JWT
		createSendToken(user, 200, res);
	}
}
